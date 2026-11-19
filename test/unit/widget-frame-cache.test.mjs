import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { headingClick, viewOf } from "../support/widget-fixture.mjs";

function fixture(t, initial = [viewOf("a", "running")]) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  let now = 1000,
    views = initial,
    revision = 0,
    lists = 0,
    stats = 0,
    requests = 0,
    frames = 0,
    component,
    onRequest;
  t.mock.method(performance, "now", () => now);
  const opens = [];
  const makeTheme = (prefix = "") => ({
    fg(_color, text) {
      if (text === "Subagents") {
        frames++;
        return prefix + text;
      }
      return text;
    },
    bold: (text) => text,
  });
  let theme = makeTheme();
  const child = {
    presentationRevision: 0,
    preview: "INITIAL_ACTIVITY",
    snapshot() {
      return { preview: this.preview, channel: "text", active_tools: [], tool_uses: 0 };
    },
  };
  const tui = {
    terminal: { columns: 120, rows: 48 },
    mode: "fullscreen",
    requestRender() {
      requests++;
      onRequest?.();
    },
  };
  const widget = new AgentWidget(
    {
      get presentationRevision() {
        return revision;
      },
      list() {
        lists++;
        return structuredClone(views);
      },
      stats() {
        stats++;
        return {
          resident: views.filter((view) => view.resident).length,
          cleanup_uncertain: false,
        };
      },
    },
    24,
    { get: (id) => (id === "a" ? child : undefined) },
  );
  const ui = () => ({
    setWidget(_key, factory) {
      component = factory?.(tui, theme);
    },
  });
  widget.setUi(ui());
  widget.onOpen((id) => opens.push(id));
  t.after(() => widget.dispose());
  widget.wake();
  return {
    widget,
    tui,
    opens,
    component: () => component,
    paint: (width = tui.terminal.columns) => component?.render(width) ?? [],
    counts: () => ({ lists, stats, requests, frames }),
    tick() {
      now += 80;
      t.mock.timers.tick(80);
    },
    activity(preview) {
      child.preview = preview;
      child.presentationRevision++;
    },
    change(next, bump = true) {
      views = next;
      if (bump) revision++;
    },
    replaceTheme() {
      theme = makeTheme("NEW_THEME_");
      component.invalidate();
      t.mock.timers.tick(0);
    },
    replaceUi() {
      widget.setUi(ui());
      widget.wake();
    },
    onRequest(handler) {
      onRequest = handler;
    },
  };
}

const agentClick = { ...headingClick, y: 1 };
const click = (h, event = agentClick) => h.component().handleMouse(event);

function nextClick(lines) {
  const y = lines.findIndex((line) => /\d+\/\d+ Next/.test(line));
  assert(y >= 0, "pagination is visible");
  return { ...headingClick, y, x: lines[y].indexOf("Next") };
}

test("a changed animation tick and actual paint compute one frame without fresh Owner reads", (t) => {
  const h = fixture(t);
  const before = h.paint();
  const held = h.counts();
  h.onRequest(() => {
    assert.equal(click(h), undefined, "old geometry retires before the draw request");
    assert.deepEqual(h.opens, []);
  });
  h.tick();
  assert.deepEqual(h.counts(), { ...held, requests: held.requests + 1, frames: held.frames + 1 });
  assert.equal(click(h), undefined, "pending geometry is not painted geometry");
  const after = h.paint();
  assert.notDeepEqual(after, before, "the spinner visibly advances");
  assert.deepEqual(h.counts(), { ...held, requests: held.requests + 1, frames: held.frames + 1 });
  assert.deepEqual(click(h), { handled: true });
  assert.deepEqual(h.opens, ["a"]);
  h.widget.agents();
  assert.equal(h.counts().lists, held.lists + 1, "explicit inspection remains fresh");
});

for (const geometry of ["width", "columns", "rows", "mode"])
  test(`pending comparison rejects changed ${geometry} before paint`, (t) => {
    const h = fixture(t);
    h.paint();
    h.tick();
    const held = h.counts();
    let width;
    if (geometry === "width") width = 42;
    if (geometry === "columns") h.tui.terminal.columns = 42;
    if (geometry === "rows") h.tui.terminal.rows = 24;
    if (geometry === "mode") h.tui.mode = "regular";
    assert.equal(click(h), undefined);
    const lines = h.paint(width);
    assert.equal(h.counts().frames, held.frames + 1, "paint must recompute for changed inputs");
    assert.equal(h.counts().lists, held.lists);
    assert.equal(h.counts().stats, held.stats);
    assert(lines.every((line) => visibleWidth(line) <= (width ?? h.tui.terminal.columns)));
    if (geometry === "mode") {
      assert(!lines[0].startsWith("▸"));
      assert.equal(click(h, headingClick), undefined, "regular mode cannot use fullscreen targets");
    } else {
      assert.deepEqual(click(h), { handled: true });
      assert.deepEqual(h.opens, ["a"]);
    }
  });

test("page changes discard an unchanged comparison without publishing its old targets", (t) => {
  const views = Array.from({ length: 20 }, (_, i) => ({
    ...viewOf(`queued-${i}`, "queued"),
    // Minute-granularity formatting keeps this tick visibly unchanged.
    elapsed_ms: 60_000,
    name: `worker-${i}`,
  }));
  const h = fixture(t, views);
  h.paint();
  assert.deepEqual(click(h, headingClick), { handled: true, render: true });
  const first = h.paint();
  const held = h.counts();
  h.tick();
  assert.equal(h.counts().requests, held.requests, "unchanged queued frames do not request a draw");
  assert.equal(h.counts().frames, held.frames + 1);
  const nav = nextClick(first);
  assert.deepEqual(click(h, nav), { handled: true, render: true });
  assert.equal(click(h, nav), undefined, "a second click cannot reuse retired page controls");
  assert.equal(click(h), undefined);
  const second = h.paint();
  assert.equal(h.counts().frames, held.frames + 2);
  assert.notEqual(second[1], first[1]);
  assert.match(second.at(-1), /2\/2/);
  assert.deepEqual(click(h), { handled: true });
  assert.deepEqual(
    h.opens,
    ["queued-14"],
    "row target belongs to the newly painted page under the 16-line budget",
  );
});

test("appearance and expansion changes cannot reuse a pending comparison", (t) => {
  const h = fixture(t);
  h.paint();
  h.tick();
  const held = h.counts();
  h.widget.setBeerMugs(true);
  assert.equal(click(h), undefined);
  assert.match(h.paint()[0], /^🍺/);
  assert.equal(h.counts().frames, held.frames + 1);
  assert.equal(h.counts().lists, held.lists);
  assert.equal(h.counts().stats, held.stats);
  assert.deepEqual(click(h, headingClick), { handled: true, render: true });
  assert.equal(click(h, headingClick), undefined);
  assert.match(h.paint()[0], /^🍻/);
});

for (const replacement of ["theme", "ui"])
  test(`${replacement} replacement retires pending frames and the previous component`, (t) => {
    const h = fixture(t);
    h.paint();
    h.tick();
    const previous = h.component();
    const held = h.counts();
    if (replacement === "theme") h.replaceTheme();
    else h.replaceUi();
    assert.notEqual(h.component(), previous);
    assert.deepEqual(previous.render(120), []);
    assert.equal(previous.handleMouse(agentClick), undefined);
    assert.equal(click(h), undefined);
    const lines = h.paint();
    assert.equal(h.counts().frames, held.frames + 1);
    if (replacement === "theme") assert.match(lines[0], /NEW_THEME_Subagents/);
    assert.deepEqual(click(h), { handled: true });
    assert.deepEqual(h.opens, ["a"]);
  });

test("later activity ticks reject pending frames even before the requested paint runs", (t) => {
  const h = fixture(t);
  h.paint();
  h.tick();
  const held = h.counts();
  h.activity("LATEST_ACTIVITY");
  h.tick();
  assert.equal(h.counts().frames, held.frames, "no comparison is needed without a painted frame");
  assert.equal(click(h), undefined);
  const lines = h.paint();
  assert.match(lines.join("\n"), /LATEST_ACTIVITY/);
  assert.doesNotMatch(lines.join("\n"), /INITIAL_ACTIVITY/);
  assert.equal(h.counts().frames, held.frames + 1);
  assert.equal(h.counts().lists, held.lists);
  assert.equal(h.counts().stats, held.stats);
});

for (const refresh of ["wake", "revision"])
  test(`${refresh} refresh replaces a pending frame and its Agent hit identities`, (t) => {
    const h = fixture(t);
    h.paint();
    h.tick();
    const held = h.counts();
    h.change([{ ...viewOf("b", "running"), name: "REPLACEMENT_AGENT" }], refresh === "revision");
    if (refresh === "wake") h.widget.wake();
    else h.tick();
    assert.equal(click(h), undefined);
    assert.match(h.paint().join("\n"), /REPLACEMENT_AGENT/);
    assert.equal(h.counts().frames, held.frames + 1);
    assert.equal(h.counts().lists, held.lists + 1);
    assert.equal(h.counts().stats, held.stats + 1);
    assert.deepEqual(click(h), { handled: true });
    assert.deepEqual(h.opens, ["b"]);
  });

test("hidden and resumed widgets cannot retain a pending frame or old mouse callbacks", (t) => {
  const h = fixture(t);
  h.paint();
  h.tick();
  const previous = h.component();
  h.change([]);
  h.widget.wake();
  assert.equal(h.component(), undefined);
  const held = h.counts();
  h.tick();
  assert.deepEqual(h.counts(), held, "hidden widgets remain offscreen without polling or draws");
  h.change([{ ...viewOf("b", "running"), name: "RESUMED_AGENT" }]);
  h.widget.wake();
  assert.deepEqual(previous.render(120), []);
  assert.equal(previous.handleMouse(agentClick), undefined);
  assert.equal(click(h), undefined);
  assert.match(h.paint().join("\n"), /RESUMED_AGENT/);
  assert.deepEqual(click(h), { handled: true });
  assert.deepEqual(h.opens, ["b"]);
});
