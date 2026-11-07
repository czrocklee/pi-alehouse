import {
  ROW_BREAK,
  theme,
  owner,
  run,
  render,
  viewOf,
  headingClick,
  refreshFixture,
  reentryHost,
} from "../support/widget-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget, renderWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { renderDetailTitle } from "../../dist/orchestration/ui/agent-detail.js";

test("missing or empty allocation metadata stays absent and raw allocation values are sanitized", () => {
  for (const [model, effort] of [
    [undefined, undefined],
    [undefined, ""],
    ["", undefined],
    [" \t\n ", "\x1b[31m\x1b[0m"],
  ]) {
    const line = render([run("missing-allocation", { status: "running", model, effort })], {
      width: 200,
    })[1];
    assert.doesNotMatch(line, /\[|\]|undefined/);
    assert(!line.includes("\x1b[31m"));
    assert.match(line, /worker/);
  }
  for (const [model, effort, allocation] of [
    [undefined, " high\t ", "[high]"],
    ["\x1b[31mm\x1b[0m", undefined, "[m]"],
    [" m\t x ", " high\n effort ", "[m x/high effort]"],
  ]) {
    const line = render([run("safe-allocation", { status: "running", model, effort })], {
      width: 200,
    })[1];
    assert(line.includes(allocation), line);
    assert.doesNotMatch(line, /undefined|[\t\n]/);
    assert(!line.includes("\x1b[31m"));
  }
});

test("the widget reports the renderer it painted into, so the pane can choose how to mount", (t) => {
  const run = {
    run_id: "r",
    agent_id: "a",
    name: "scout",
    description: "d",
    status: "running",
    phase: "streaming",
    execution_exited: false,
    finalization_pending: false,
    resident: true,
    resumable: false,
    owner_blocked: false,
    pending_messages: 0,
    isolation: "shared",
    elapsed_ms: 1,
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
      cwd: "/tmp",
      tools: [],
      definition_digest: "0".repeat(64),
      context_mode: "none",
    },
  };
  const widget = new AgentWidget(
    { list: () => [run], stats: () => ({ resident: 1, cleanup_uncertain: false }) },
    8,
  );
  t.after(() => widget.dispose());
  // Nothing painted yet: the caller must read this as "assume the safe renderer".
  assert.equal(widget.tuiMode(), undefined);
  let factory;
  widget.setUi({
    setWidget: (_key, content) => {
      factory = content;
    },
  });
  widget.update();
  assert.equal(typeof factory, "function");
  assert.equal(widget.tuiMode(), undefined, "still unpainted until the factory runs");
  factory({ terminal: { columns: 80 }, mode: "fullscreen", requestRender() {} }, theme);
  assert.equal(widget.tuiMode(), "fullscreen");
  // A host that predates the field must not be mistaken for the alternate screen.
  widget.setUi({
    setWidget: (_key, content) => {
      factory = content;
    },
  });
  widget.update();
  factory({ terminal: { columns: 80 }, requestRender() {} }, theme);
  assert.equal(widget.tuiMode(), undefined);
});

test("raw widget metadata cannot inject protocols, bidi or row controls, while theme ANSI survives", () => {
  const styled = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  const payloads = [
    "\x1b[31m",
    "\x1b]8;;https://invalid.test\x07",
    "\x1b]133;A\x1b\\",
    "\x1bPdata\x1b\\",
    "\x1b[",
    "\x9b31m",
    "\x00\x08\x7f",
    "\u202e\u2066\u2069",
    "\t\r\n\u0085\u2028\u2029\u00a0",
  ];
  for (const payload of payloads)
    for (const status of ["running", "failed", "cancelled", "queued"]) {
      const raw = `left${payload}right`,
        row = run("raw-id", {
          status,
          name: raw,
          profile: raw,
          model: raw,
          effort: raw,
          description: raw,
          error: raw,
          reason: raw,
          preview: raw,
          active_tools: [{ name: raw, detail: raw }],
        });
      for (const width of [24, 80, 400]) {
        const options = { width, expanded: true, owner: { ...owner, blocked: true, error: raw } };
        const lines = render([row], { ...options, theme: styled });
        assert(
          lines.some((line) => line.includes("\x1b[36m")),
          "trusted theme styles remain",
        );
        assert.deepEqual(
          lines.map(stripTerminalSequences),
          render([row], options).map(stripTerminalSequences),
          "sanitization precedes styling and measurement; clipping may add trusted SGR resets",
        );
        for (const line of lines) {
          assert(visibleWidth(line) <= width);
          assert(!line.includes("\x1b[31m"), "raw SGR must not survive");
          assert.doesNotMatch(stripTerminalSequences(line), /[\p{Cc}\p{Bidi_Control}]/u);
          assert(!["\x1b]", "\x1bP", "\x9b"].some((sequence) => line.includes(sequence)));
        }
      }
      const preview = render([run("preview", { status: "running", preview: raw })], { width: 400 });
      assert.doesNotMatch(
        preview.map(stripTerminalSequences).join(""),
        /[\p{Cc}\p{Bidi_Control}]/u,
      );
      const reason = render([run("reason", { status: "failed", reason: raw })], { width: 400 });
      assert.doesNotMatch(reason.map(stripTerminalSequences).join(""), /[\p{Cc}\p{Bidi_Control}]/u);
    }
  const clean = render(
    [
      run("space", {
        status: "running",
        name: "  rev\t\n bot  ",
        model: " m\t x ",
        effort: " high\u00a0 effort ",
        description: " check\r\nthe\t tests ",
      }),
    ],
    { width: 200 },
  );
  assert.match(clean[1], /rev bot .*\[m x\/high effort\] → check the tests/);
  const styledName = render([run("styled", { status: "running", name: "rev\x1b[31m\tbot" })], {
    width: 200,
    theme: styled,
  });
  assert(
    styledName[1].includes("\x1b[1mrev bot\x1b[0m"),
    "trusted bold is applied after raw name sanitization",
  );
});

test("nothing that reaches a row can end it early", () => {
  const frame = renderWidget({
    runs: [
      run("a", {
        status: "running",
        name: "rev\nbot",
        description: "Review the code\r\nand tests",
        active_tools: [{ name: "bash", detail: "make\ttest" }],
      }),
    ],
    owner: { blocked: true, error: "boom\n  at foo()\n  at bar()", resident: 1, resident_limit: 8 },
    spinnerFrame: 0,
    width: 120,
    theme,
    shouldShowFinished: () => true,
  });
  for (const line of frame.lines) {
    assert.doesNotMatch(line, ROW_BREAK, `row would break: ${JSON.stringify(line)}`);
    assert.ok(visibleWidth(line) <= 120);
  }
  assert.equal(frame.lines.length, frame.hits.length, "one hit per painted row");
  // Folded to spaces, not dropped: the text is still readable and still attributed.
  assert.match(frame.lines[1], /owner blocked: boom +at foo\(\) +at bar\(\)/);
  assert.match(frame.lines[2], /rev bot/);
  assert.match(frame.lines[2], /Review the code and tests/);
  assert.match(frame.lines[3], /running make test/);
  assert.equal(frame.hits[2], "a");
});

test("a detail title stays one row however it is labelled", () => {
  const view = {
    run_id: "r-1",
    agent_id: "a-1",
    name: "rev\nbot",
    description: "Check\nthe\ttests",
    status: "running",
    turns: 1,
    max_turns: 8,
    elapsed_ms: 10,
    effective_settings: {
      provider: "p",
      model: "m",
      thinking: "high",
      parent_thinking: "high",
      thinking_resolution: "identity",
      profile: "worker\nreadonly",
      difficulty: 5,
      strength: "d5",
      preset: "fixture",
      preset_version: "v1",
      selection_digest: "1".repeat(64),
      cwd: "/w",
      tools: [],
      context_mode: "none",
    },
    owner_blocked: false,
    pending_messages: 0,
    cleanup_errors: [],
    discarded_inputs: [],
    execution_exited: false,
    finalization_pending: false,
    resumable: true,
    isolation: "shared",
    phase: "executing",
  };
  const live = { active_tools: [], tool_uses: 0, preview: "" };
  const title = renderDetailTitle({ view, live }, 0, theme, 120);
  assert.doesNotMatch(
    title,
    /[\t\n\v\f\r]/,
    `title would break the frame: ${JSON.stringify(title)}`,
  );
  assert.ok(visibleWidth(title) <= 120);
});

test("expanded idle state survives resizing and a successful theme replacement without reviving stale hits", (t) => {
  const h = refreshFixture(t, "completed");
  h.widget.wake();
  const old = h.component();
  old.render(120);
  old.handleMouse(headingClick);
  h.widget.onTurnStart();
  assert.match(old.render(40)[0], /^▾ Subagents/);
  assert.equal(old.render(40).length, 2, "expanded idle rows ignore normal linger expiry");
  old.invalidate();
  const invalidated = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(
    h.counts(),
    invalidated,
    "invalidation immediately drops heading and Agent targets",
  );
  t.mock.timers.tick(1);
  const current = h.component();
  assert.notEqual(current, old);
  assert.equal(
    current.handleMouse(headingClick),
    undefined,
    "replacement has no heading bounds before paint",
  );
  assert.match(current.render(120)[0], /^▾ Subagents/);
  const held = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.counts(), held);
  t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), held, "a completed roster does not start animating after refresh");
  current.handleMouse(headingClick);
  assert.deepEqual(current.render(120), ["▸ Subagents · ✓1"]);
});

test("theme replacement retires page controls immediately and preserves roster expansion", (t) => {
  const h = refreshFixture(t, "completed");
  h.set(
    Array.from({ length: 12 }, (_, i) => ({ ...viewOf(`id-${i}`, "completed"), name: `idle${i}` })),
  );
  h.widget.wake();
  const old = h.component();
  old.render(120);
  old.handleMouse(headingClick);
  const lines = old.render(120),
    y = lines.length - 1,
    x = lines[y].indexOf("[Next]");
  assert.deepEqual(old.handleMouse({ ...headingClick, y, x }), { handled: true, render: true });
  assert.match(old.render(120)[1], /idle4 /);
  old.invalidate();
  assert.equal(old.handleMouse({ ...headingClick, y, x }), undefined);
  t.mock.timers.tick(1);
  const current = h.component();
  assert.equal(
    current.handleMouse({ ...headingClick, y, x }),
    undefined,
    "new geometry requires a paint",
  );
  assert.match(current.render(120)[0], /^▾ Subagents/);
  assert.equal(
    old.handleMouse(headingClick),
    undefined,
    "retired page callbacks cannot collapse the replacement",
  );
  assert.equal(old.handleMouse({ ...headingClick, y, x }), undefined);
  assert.match(current.render(120)[1], /idle0 /);
});

for (const phase of ["retained", "removed", "installed"]) {
  test(`failed refresh disables heading clicks but preserves expansion for recovery (host=${phase})`, (t) => {
    const h = refreshFixture(t, "completed");
    h.widget.wake();
    const old = h.component();
    old.render(120);
    old.handleMouse(headingClick);
    old.render(120);
    h.widget.onTurnStart();
    h.fail(phase);
    old.invalidate();
    t.mock.timers.tick(1);
    const failed = h.counts();
    assert.equal(old.handleMouse(headingClick), undefined);
    assert.equal(h.component()?.handleMouse(headingClick), undefined);
    assert.deepEqual(h.counts(), failed, "failed registration cannot accept a stale heading click");
    h.widget.wake();
    const current = h.component();
    assert.equal(current.handleMouse(headingClick), undefined);
    assert.match(current.render(120)[0], /^▾ Subagents/);
    assert.equal(current.render(120).length, 2);
    current.handleMouse(headingClick);
    assert.deepEqual(current.render(120), ["▸ Subagents · ✓1"]);
  });
}

test("failed Owner projection clears heading targets and resets expansion", (t) => {
  const h = refreshFixture(t, "completed");
  h.widget.wake();
  const old = h.component();
  old.render(120);
  old.handleMouse(headingClick);
  old.render(120);
  h.failProjection(true);
  h.widget.wake();
  assert.equal(h.component(), undefined);
  const failed = h.counts();
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.equal(old.handleMouse({ ...headingClick, y: 1 }), undefined);
  assert.deepEqual(h.counts(), failed);
  h.failProjection(false);
  h.widget.wake();
  assert.equal(h.component().handleMouse(headingClick), undefined);
  assert.match(h.component().render(120)[0], /^▸ Subagents/);
});

for (const status of ["running", "completed"])
  for (const phase of ["retained", "removed", "installed"]) {
    test(`failed theme refresh recovers on a later wake (status=${status}, host=${phase})`, (t) => {
      const h = refreshFixture(t, status);
      h.widget.wake();
      const old = h.component();
      old.render(120);
      h.fail(phase);
      old.invalidate();
      old.invalidate();
      assert.doesNotThrow(
        () => t.mock.timers.tick(1),
        "the scheduled refresh must contain host errors",
      );
      assert.equal(h.counts().mounts, 2, "repeated invalidation coalesces into one attempt");
      assert.equal(
        h.widget.tuiMode(),
        "fullscreen",
        "losing a component does not lose the renderer mode",
      );
      const held = h.counts();
      t.mock.timers.tick(1000);
      assert.deepEqual(
        h.counts(),
        held,
        "failure stops animation instead of spinning on a broken host",
      );
      h.component()?.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
      assert.equal(h.counts().opens, 0, "failed replacement drops stale hit targets");
      assert.doesNotThrow(() => h.widget.wake());
      assert.equal(
        h.counts().mounts,
        3,
        "a normal wake retries registration, not an absent TUI render",
      );
      assert.notEqual(h.component(), old);
      assert.match(h.component().render(120).join("\n"), /worker/);
      h.component().handleMouse({ type: "click", button: "left", x: 0, y: 1 });
      assert.equal(h.counts().opens, 1, "the recovered component is interactive");
      h.widget.wake();
      assert.equal(h.counts().mounts, 3, "successful registration clears the refresh intent");
      const rendered = h.counts().renders;
      t.mock.timers.tick(160);
      assert.equal(
        h.counts().renders - rendered,
        status === "running" ? 2 : 0,
        "only a running widget resumes animation, without duplicate intervals",
      );
    });
  }

for (const phase of ["retained", "removed", "installed"]) {
  test(`idle after failed theme refresh still clears the host (host=${phase})`, (t) => {
    const h = refreshFixture(t);
    h.widget.wake();
    h.fail(phase);
    h.component().invalidate();
    assert.doesNotThrow(() => t.mock.timers.tick(1));
    h.set([]);
    h.widget.wake();
    assert.equal(h.counts().removals, 1);
    assert.equal(h.component(), undefined);
    const cleared = h.counts();
    t.mock.timers.tick(1000);
    assert.deepEqual(h.counts(), cleared);
    h.set([viewOf("b", "running")]);
    h.widget.wake();
    assert.equal(h.counts().mounts, 3, "fresh activity can mount after idle cleanup");
    assert(h.component());
  });
  for (const removalFails of [false, true]) {
    test(`dispose after failed theme refresh detaches everything (host=${phase}, clearThrows=${removalFails})`, (t) => {
      const h = refreshFixture(t);
      h.widget.wake();
      const old = h.component();
      old.render(120);
      h.fail(phase);
      old.invalidate();
      assert.doesNotThrow(() => t.mock.timers.tick(1));
      old.invalidate(); // Even a host retaining the old component cannot outlive disposal.
      if (removalFails) {
        h.failRemoval();
        assert.throws(() => h.widget.dispose(), /WIDGET_CLEAR_FAILED/);
      } else assert.doesNotThrow(() => h.widget.dispose());
      assert.equal(h.counts().removals, 1);
      assert.equal(h.widget.tuiMode(), undefined);
      const disposed = h.counts();
      old.invalidate();
      old.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
      h.widget.wake();
      h.widget.dispose();
      t.mock.timers.tick(1000);
      assert.deepEqual(
        h.counts(),
        disposed,
        "no timer, mount, click or repeated clear survives disposal",
      );
    });
  }
}

test("failed theme refresh cancels invalidation scheduled during partial installation", (t) => {
  const h = refreshFixture(t);
  h.widget.wake();
  h.fail("invalidated");
  h.component().invalidate();
  assert.doesNotThrow(() => t.mock.timers.tick(1));
  assert.equal(h.counts().mounts, 2);
  const failed = h.counts();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), failed, "a failed host cannot leave a self-retrying repaint timer");
  h.widget.wake();
  assert.equal(h.counts().mounts, 3);
});

test("scheduled idle removal failure is contained without leaving a paint loop", (t) => {
  const h = refreshFixture(t);
  h.widget.wake();
  h.component().invalidate();
  h.set([]);
  h.failRemoval();
  assert.doesNotThrow(() => t.mock.timers.tick(1));
  assert.equal(h.counts().removals, 1);
  const failed = h.counts();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), failed);
});

test("a partially installed initial widget is still removed on disposal", (t) => {
  const h = refreshFixture(t);
  h.fail("installed");
  assert.throws(() => h.widget.wake(), /WIDGET_REFRESH_FAILED/);
  assert(h.component());
  h.widget.dispose();
  assert.equal(h.counts().removals, 1);
  assert.equal(h.component(), undefined);
  const disposed = h.counts();
  t.mock.timers.tick(1000);
  assert.deepEqual(h.counts(), disposed);
});

test("a queued theme refresh still removes a widget that became idle before repaint", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let views = [viewOf("a", "running")],
    component,
    removals = 0;
  const widget = new AgentWidget(
    { list: () => views, stats: () => ({ resident: views.length, cleanup_uncertain: false }) },
    8,
  );
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) removals++;
      component = factory?.({ terminal: { columns: 120 }, requestRender() {} }, theme);
    },
  });
  t.after(() => widget.dispose());
  widget.wake();
  component.invalidate();
  views = [];
  t.mock.timers.tick(1);
  assert.equal(component, undefined);
  assert.equal(removals, 1);
});

for (const invalidated of [false, true])
  test(`throwing widget removal still releases timers and bindings (invalidated=${invalidated})`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const timers = new Set();
    for (const [start, stop] of [
      ["setInterval", "clearInterval"],
      ["setTimeout", "clearTimeout"],
    ]) {
      const schedule = globalThis[start],
        cancel = globalThis[stop];
      t.mock.method(globalThis, start, (...args) => {
        const timer = schedule(...args);
        timers.add(timer);
        return timer;
      });
      t.mock.method(globalThis, stop, (timer) => {
        timers.delete(timer);
        cancel(timer);
      });
    }
    let component,
      paints = 0,
      removals = 0,
      opens = 0;
    const widget = new AgentWidget(
      {
        list: () => [viewOf("a", "running")],
        stats: () => ({ resident: 1, cleanup_uncertain: false }),
      },
      8,
    );
    widget.onOpen(() => {
      opens++;
    });
    widget.setUi({
      setWidget(_key, factory) {
        if (!factory) {
          removals++;
          throw new Error("WIDGET_CLEAR_FAILED");
        }
        paints++;
        component = factory(
          {
            terminal: { columns: 120 },
            mode: "fullscreen",
            requestRender() {
              paints++;
            },
          },
          theme,
        );
      },
    });
    t.after(() => widget.dispose());
    widget.wake();
    component.render(120);
    assert.equal(timers.size, 1);
    if (invalidated) {
      component.invalidate();
      assert.equal(timers.size, 2);
    }
    assert.throws(() => widget.dispose(), /WIDGET_CLEAR_FAILED/);
    assert.equal(removals, 1);
    assert.equal(
      timers.size,
      0,
      "both animation and deferred repaint are cancelled before the setter",
    );
    assert.equal(widget.tuiMode(), undefined);
    const painted = paints;
    widget.wake();
    component.invalidate();
    component.handleMouse({ type: "click", button: "left", x: 0, y: 1 });
    widget.dispose();
    t.mock.timers.tick(1000);
    assert.equal(removals, 1);
    assert.equal(timers.size, 0);
    assert.equal(paints, painted);
    assert.equal(opens, 0, "a host retaining its broken component cannot call the detached panel");
  });

test("a wake before setWidget applies its factory does not install a competing one", (t) => {
  const views = [viewOf("a", "completed")];
  const h = reentryHost(t, views);
  h.setMode("before");
  h.widget.wake();
  assert.equal(h.counts().mounts, 1, "the nested wake stays on the outer registration");
  const installed = h.component();
  assert.match(
    installed.render(120).join("\n"),
    /▸ Subagents/,
    "the outer factory remains current, not a blank epoch mismatch",
  );
  assert.deepEqual(installed.handleMouse(headingClick), { handled: true, render: true });
  const paints = h.counts().renders;
  h.widget.wake();
  assert.equal(h.counts().mounts, 1, "successful outer registration is reused");
  assert.ok(h.counts().renders > paints, "a later wake only requests paint");
  h.setMode("refresh");
  h.widget.update(true);
  assert.equal(h.counts().mounts, 2, "a later forced refresh still replaces the factory");
  assert.equal(installed.handleMouse(headingClick), undefined, "the retired factory cannot act");
});

test("a pending wake refreshes the detached cache after the outer factory is installed", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const views = [{ ...viewOf("a", "completed"), name: "before" }];
  let component,
    mounts = 0,
    reads = 0,
    renders = 0;
  const widget = new AgentWidget(
    {
      list: () => {
        reads++;
        return views;
      },
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = {
    terminal: { columns: 120, rows: 36 },
    mode: "fullscreen",
    requestRender() {
      renders++;
    },
  };
  t.after(() => widget.dispose());
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) {
        component = undefined;
        return;
      }
      mounts++;
      views[0] = { ...views[0], name: "during", description: "fresh task" };
      widget.wake();
      widget.update(true);
      component = factory(tui, theme);
    },
  });
  widget.wake();
  assert.equal(mounts, 1, "nested ordinary and forced wakes coalesce into the current factory");
  assert.equal(reads, 2, "one post-install projection observes changes made by the setter");
  const painted = component.render(120);
  assert.match(painted[1], /during .*fresh task/);
  for (let i = 0; i < 10; i++) assert.deepEqual(component.render(120), painted);
  const held = { mounts, reads, renders };
  t.mock.timers.tick(1000);
  assert.deepEqual(
    { mounts, reads, renders },
    held,
    "idle registration leaves no autonomous retry or animation",
  );
});

test("a wake after the factory is created still leaves one current component", (t) => {
  const h = reentryHost(t, [viewOf("a", "completed")]);
  h.setMode("after");
  h.widget.wake();
  assert.equal(h.counts().mounts, 1);
  assert.match(h.component().render(120).join("\n"), /▸ Subagents/);
  h.widget.wake();
  assert.equal(h.counts().mounts, 1);
});

test("a failed reentrant setter drops pending retries and recovers on an external wake", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component,
    fail = true,
    mounts = 0;
  const widget = new AgentWidget(
    {
      list: () => [viewOf("a", "completed")],
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) {
        component = undefined;
        return;
      }
      mounts++;
      widget.wake();
      component = factory(tui, theme);
      if (fail) throw new Error("REENTRANT_SETTER_FAILED");
    },
  });
  assert.throws(() => widget.wake(), /REENTRANT_SETTER_FAILED/);
  component.render(120);
  assert.equal(component.handleMouse(headingClick), undefined);
  t.mock.timers.tick(1000);
  assert.equal(mounts, 1, "failure does not retry itself");
  fail = false;
  widget.wake();
  assert.equal(mounts, 2);
  assert.match(component.render(120).join("\n"), /▸ Subagents/);
  assert.deepEqual(component.handleMouse(headingClick), { handled: true, render: true });
});

for (const stage of ["before", "after"])
  test(`a setter can dispose during factory application (${stage})`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let component,
      mounts = 0;
    const widget = new AgentWidget(
      {
        list: () => [viewOf("a", "completed")],
        stats: () => ({ resident: 1, cleanup_uncertain: false }),
      },
      8,
    );
    const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
    t.after(() => widget.dispose());
    widget.setUi({
      setWidget(_key, factory) {
        if (!factory) {
          component = undefined;
          return;
        }
        mounts++;
        widget.wake();
        if (stage === "before") widget.dispose();
        const installed = factory(tui, theme);
        if (stage === "after") widget.dispose();
        component = installed; // A partially applying host may retain a retired component.
      },
    });
    assert.doesNotThrow(() => widget.wake());
    assert.deepEqual(component.render(120), []);
    assert.equal(component.handleMouse?.(headingClick), undefined);
    component.invalidate();
    widget.wake();
    t.mock.timers.tick(1000);
    assert.equal(mounts, 1, "retirement cannot trigger another registration");
  });

test("an old setter cannot clear a replacement UI's registration state", (t) => {
  let oldComponent,
    current,
    mounts = 0;
  const widget = new AgentWidget(
    {
      list: () => [viewOf("a", "completed")],
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  const replacement = {
    setWidget(_key, factory) {
      if (!factory) {
        current = undefined;
        return;
      }
      mounts++;
      widget.wake();
      current = factory(tui, theme);
    },
  };
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) return;
      widget.setUi(replacement);
      widget.wake();
      oldComponent = factory(tui, theme);
    },
  });
  assert.doesNotThrow(() => widget.wake());
  assert.equal(mounts, 1);
  assert.deepEqual(oldComponent.render(120), []);
  assert.match(current.render(120).join("\n"), /▸ Subagents/);
  widget.wake();
  assert.equal(mounts, 1, "the replacement's installed component is still current");
});

test("a failed mount retains removal ownership but cannot revive its factory or instance", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let factory,
    component,
    fail = true,
    mounts = 0,
    removals = 0;
  const widget = new AgentWidget(
    {
      list: () => [viewOf("a", "completed")],
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = { terminal: { columns: 120, rows: 36 }, mode: "fullscreen", requestRender() {} };
  t.after(() => widget.dispose());
  widget.setUi({
    setWidget(_key, content) {
      if (!content) {
        removals++;
        return;
      }
      mounts++;
      factory = content;
      component = content(tui, theme);
      if (fail) throw new Error("PARTIAL_MOUNT_FAILED");
    },
  });
  assert.throws(() => widget.wake(), /PARTIAL_MOUNT_FAILED/);
  const oldFactory = factory,
    old = component;
  assert.deepEqual(old.render(120), [], "a partially applied component is retired on failure");
  const late = oldFactory({ ...tui, mode: "regular" }, theme);
  assert.deepEqual(late.render(120), [], "the failed factory cannot reacquire an instance");
  old.invalidate();
  late.invalidate();
  t.mock.timers.tick(1000);
  assert.equal(mounts, 1, "failure cannot schedule its own retry");
  assert.equal(
    widget.tuiMode(),
    "fullscreen",
    "stale factory calls cannot change the last known renderer",
  );
  fail = false;
  widget.wake();
  assert.equal(mounts, 2);
  assert.match(component.render(120)[0], /▸ Subagents/);
  assert.equal(old.handleMouse(headingClick), undefined);
  assert.deepEqual(oldFactory(tui, theme).render(120), []);
  widget.dispose();
  widget.dispose();
  assert.equal(removals, 1, "all failed/ready attempts share the one host slot");
});

for (const timer of [false, true])
  test(`a failed render request retires only its mount (timer=${timer})`, (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    let component,
      fail = false,
      mounts = 0,
      reads = 0,
      renders = 0;
    const widget = new AgentWidget(
      {
        list: () => {
          reads++;
          return [viewOf("a", "running")];
        },
        stats: () => ({ resident: 1, cleanup_uncertain: false }),
      },
      8,
    );
    const tui = {
      terminal: { columns: 120, rows: 36 },
      mode: "fullscreen",
      requestRender() {
        renders++;
        if (fail) throw new Error("RENDER_REQUEST_FAILED");
      },
    };
    t.after(() => widget.dispose());
    widget.setUi({
      setWidget(_key, factory) {
        if (!factory) return;
        mounts++;
        component = factory(tui, theme);
      },
    });
    widget.wake();
    const old = component;
    old.render(120);
    fail = true;
    if (timer) assert.doesNotThrow(() => t.mock.timers.tick(80));
    else assert.throws(() => widget.wake(), /RENDER_REQUEST_FAILED/);
    assert.deepEqual(old.render(120), []);
    assert.equal(old.handleMouse(headingClick), undefined);
    const held = { mounts, reads, renders };
    old.invalidate();
    t.mock.timers.tick(1000);
    assert.deepEqual(
      { mounts, reads, renders },
      held,
      "the failed request leaves no live animation/repaint",
    );
    assert.equal(widget.tuiMode(), "fullscreen");
    fail = false;
    widget.wake();
    assert.equal(mounts, 2);
    assert.match(component.render(120)[0], /▸ Subagents/);
    assert.equal(old.handleMouse(headingClick), undefined);
  });

test("an older setter failure cannot retire a synchronously rebound ready mount", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let component,
    mounts = 0,
    renders = 0;
  const widget = new AgentWidget(
    {
      list: () => [viewOf("a", "running")],
      stats: () => ({ resident: 1, cleanup_uncertain: false }),
    },
    8,
  );
  const tui = {
    terminal: { columns: 120, rows: 36 },
    mode: "fullscreen",
    requestRender() {
      renders++;
    },
  };
  t.after(() => widget.dispose());
  const replacement = {
    setWidget(_key, factory) {
      if (!factory) return;
      mounts++;
      component = factory(tui, theme);
    },
  };
  widget.setUi({
    setWidget(_key, factory) {
      if (!factory) return;
      widget.setUi(replacement);
      widget.wake();
      throw new Error("RETIRED_SETTER_FAILED");
    },
  });
  assert.throws(() => widget.wake(), /RETIRED_SETTER_FAILED/);
  assert.match(component.render(120)[0], /▸ Subagents/);
  const before = renders;
  t.mock.timers.tick(160);
  assert.equal(renders - before, 2, "the older exception cannot stop the new lifetime's timer");
  widget.wake();
  assert.equal(mounts, 1, "the new ready mount does not need repair");
});
