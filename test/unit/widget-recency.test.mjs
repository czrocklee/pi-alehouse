import assert from "node:assert/strict";
import test from "node:test";
import { AgentWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { DetailPane } from "../../dist/orchestration/ui/agent-detail.js";
import { boundedOutput } from "../../dist/orchestration/core/result-text.js";
import { createOwnerTools } from "../../dist/orchestration/tools/parent-tools.js";
import { ended, fixture, until } from "../support/controller-fixture.mjs";
import { headingClick, mounted, theme, viewOf } from "../support/widget-fixture.mjs";

test("new admission sequences move reused Agents without changing detail order", (t) => {
  const views = [
    { ...viewOf("a", "completed"), name: "alpha", enqueue_sequence: 1 },
    { ...viewOf("b", "completed"), name: "bravo", enqueue_sequence: 2 },
    { ...viewOf("c", "completed"), name: "charlie", enqueue_sequence: 3 },
  ];
  const h = mounted(views);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  const detailOrder = () => h.widget.agents().map((agent) => agent.agent_id);
  const paintedOrder = () =>
    h
      .lines()
      .flatMap((line) =>
        ["alpha", "bravo", "charlie"].filter((name) => line.includes(` ${name} `)),
      );
  const check = (expected) => {
    assert.deepEqual(detailOrder(), ["a", "b", "c"]);
    assert.deepEqual(
      h.widget.presentationAgents().map((agent) => agent.agent_id),
      ["a", "b", "c"],
    );
    assert.deepEqual(paintedOrder(), expected);
  };
  check(["charlie", "bravo", "alpha"]);
  h.set([{ ...views[0], run_id: "a-2", enqueue_sequence: 4 }, ...views.slice(1)]);
  h.widget.wake();
  check(["alpha", "charlie", "bravo"]);
  h.set([
    { ...views[0], run_id: "a-2", enqueue_sequence: 4 },
    { ...views[1], run_id: "b-2", enqueue_sequence: 5 },
    views[2],
  ]);
  h.widget.wake();
  check(["bravo", "alpha", "charlie"]);
});

test("detail roster appends new Agents and preserves survivors when released diagnostics expire", (t) => {
  const views = [
    { ...viewOf("a", "completed"), enqueue_sequence: 1 },
    { ...viewOf("b", "failed"), enqueue_sequence: 2, resident: false },
    { ...viewOf("c", "completed"), enqueue_sequence: 3 },
  ];
  const h = mounted(views);
  t.after(() => h.widget.dispose());
  h.widget.wake();
  const check = (expected) => {
    assert.deepEqual(
      h.widget.agents().map((agent) => agent.agent_id),
      expected,
    );
    assert.deepEqual(
      h.widget.presentationAgents().map((agent) => agent.agent_id),
      expected,
    );
  };
  check(["a", "b", "c"]);
  h.set([...views, { ...viewOf("d", "completed"), enqueue_sequence: 4 }]);
  h.widget.wake();
  check(["a", "b", "c", "d"]);
  for (let turn = 0; turn < 3; turn++) h.widget.onTurnStart();
  check(["a", "c", "d"]);
});

function toolsFor(f) {
  const model = { provider: "fixture", id: "controlled" };
  const ctx = {
    sessionManager: { getSessionId: () => f.owner_id },
    modelRegistry: { getAll: () => [model] },
    cwd: "/tmp",
    thinkingLevel: "off",
  };
  const route = {
    name: "fixture",
    version: "v1",
    digest: "a".repeat(64),
    models: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d${n}`, "fixture/controlled"])),
    effort: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d${n}`, "off"])),
    effort_defaults: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`d${n}`, "off"])),
    effort_overrides: {},
  };
  const tools = createOwnerTools({
    controller: f.controller,
    context: ctx,
    profiles: Object.fromEntries(
      ["editor", "researcher"].map((profile) => [
        profile,
        { definition: profile, tools: ["read"] },
      ]),
    ),
    getSupportedThinkingLevels: () => ["off"],
    getPreset: () => route,
  });
  let id = 0;
  return async (name, args) =>
    JSON.parse(
      (
        await tools
          .find((tool) => tool.name === name)
          .execute(`recency-${++id}`, args, undefined, undefined, ctx)
      ).content[0].text,
    );
}

test("real Owner drives recent widget rows and stable detail, model and Owner order", async (t) => {
  let wall = 100;
  const f = await fixture(t, {
    controller: { clock: { wall: () => wall, mono: () => performance.now() } },
  });
  const call = toolsFor(f);
  let component;
  const tui = { terminal: { columns: 160, rows: 48 }, mode: "fullscreen", requestRender() {} };
  const widget = new AgentWidget(f.controller, 8);
  widget.setUi({
    setWidget: (_key, factory) => {
      component = factory?.(tui, theme);
    },
  });
  t.after(() => widget.dispose());
  const ids = {};
  for (const [name, timestamp, sequence] of [
    ["alpha", 100, 1],
    ["bravo", 100, 2],
    ["charlie", 50, 3],
  ]) {
    wall = timestamp;
    await call("agent_spawn", {
      agent: name,
      profile: "worker",
      reasoning_difficulty: 1,
      prompt: name,
      label: `First ${name}`,
    });
    const run = f.controller.findAgent(name);
    ids[name] = run.agent_id;
    assert.equal(f.controller.view(run.run_id).enqueue_sequence, sequence);
    await until(() => f.ports.at(-1)?.streaming);
    f.ports.at(-1).finish(`result ${name}`);
    await ended(f.controller, run);
  }
  const original = f.controller.view(f.controller.findAgent("alpha").run_id);
  original.enqueue_sequence = -1;
  assert.equal(
    f.controller.view(original.run_id).enqueue_sequence,
    1,
    "the projection is detached from the retained Run",
  );
  const ownerOrder = () => f.controller.list({ include_released: true }).map((v) => v.agent_id);
  const modelOrder = async () => {
    const rows = (await call("agent_list", {})).agents;
    for (const row of rows) {
      assert.equal(Object.hasOwn(row, "enqueue_sequence"), false);
      assert.equal(Object.hasOwn(row, "submitted_at"), false);
    }
    return rows.map((row) => row.agent);
  };
  assert.deepEqual(ownerOrder(), [ids.alpha, ids.bravo, ids.charlie]);
  assert.deepEqual(await modelOrder(), ["alpha", "bravo", "charlie"]);
  const uiOrder = () => widget.agents().map((agent) => agent.agent_id);
  const namesIn = (lines) =>
    lines.flatMap((line) =>
      ["alpha", "bravo", "charlie"].filter((name) => line.includes(` ${name} `)),
    );
  widget.wake();
  assert.deepEqual(uiOrder(), [ids.alpha, ids.bravo, ids.charlie]);
  assert.deepEqual(
    widget.presentationAgents().map((agent) => agent.agent_id),
    [ids.alpha, ids.bravo, ids.charlie],
  );
  assert.deepEqual(namesIn(component.render(160)), ["charlie", "bravo", "alpha"]);
  component.handleMouse(headingClick);
  assert.deepEqual(namesIn(component.render(160)), ["charlie", "bravo", "alpha"]);
  const detailEntries = (agents) =>
    agents.map((agent) => ({
      agent_id: agent.agent_id,
      input: { view: agent.view, live: agent.live },
    }));
  const pane = new DetailPane({
    tui,
    theme,
    initial: ids.bravo,
    done() {},
    snapshot: () => detailEntries(widget.presentationAgents()),
    freshSnapshot: () => detailEntries(widget.agents()),
    revision: () => widget.presentationVersion(),
    transcript: () => undefined,
  });
  t.after(() => pane.dispose());
  let lines = pane.render(160);
  assert.match(lines[0], /bravo/);
  assert(lines.at(-1).indexOf("alpha") >= 0);
  assert(lines.at(-1).indexOf("alpha") < lines.at(-1).indexOf("bravo"));
  assert(lines.at(-1).indexOf("bravo") < lines.at(-1).indexOf("charlie"));
  const initialVersion = widget.presentationVersion();
  assert.notEqual(initialVersion, undefined);

  const opened = [];
  widget.onOpen((id) => opened.push(id));
  wall = 25;
  await call("agent_run", {
    agent: "alpha",
    continues: "Follow up on alpha",
    prompt: "Follow up",
    label: "Second alpha",
  });
  await until(() => f.ports[0].calls.length === 2 && f.ports[0].streaming);
  assert.equal(f.controller.view(original.run_id).enqueue_sequence, 1);
  assert.equal(f.controller.view(f.controller.findAgent("alpha").run_id).enqueue_sequence, 4);
  assert.notEqual(
    widget.presentationVersion(),
    initialVersion,
    "Owner admission invalidates pane presentation",
  );
  lines = pane.render(160);
  assert.match(lines[0], /bravo/, "cached pane keeps its selected Agent before widget wake");
  assert(lines.at(-1).indexOf("alpha") < lines.at(-1).indexOf("bravo"));
  assert(lines.at(-1).indexOf("bravo") < lines.at(-1).indexOf("charlie"));
  pane.handleInput("\u001b[D");
  lines = pane.render(160);
  assert.match(lines[0], /alpha/);
  assert.match(
    lines[0],
    /Second alpha/,
    "the cached pane sees the replacement Run before widget wake",
  );
  pane.handleInput("\u001b[C");
  assert.match(pane.render(160)[0], /bravo/);
  pane.handleInput("\u001b[C");
  assert.match(pane.render(160)[0], /charlie/);
  pane.handleInput("\u001b[D");
  assert.match(pane.render(160)[0], /bravo/);
  widget.wake();
  assert.equal(
    component.handleMouse({ ...headingClick, y: 1 }),
    undefined,
    "old row hits retire on wake",
  );
  assert.deepEqual(uiOrder(), [ids.alpha, ids.bravo, ids.charlie]);
  assert.deepEqual(await modelOrder(), ["alpha", "bravo", "charlie"]);
  assert.deepEqual(namesIn(component.render(160)), ["alpha", "charlie", "bravo"]);
  component.handleMouse({ ...headingClick, y: 1 });
  assert.deepEqual(opened, [ids.alpha]);
  lines = pane.render(160);
  assert.match(lines[0], /bravo/, "selection remains on the same Agent after widget reordering");
  assert(lines.at(-1).indexOf("alpha") < lines.at(-1).indexOf("bravo"));
  assert(lines.at(-1).indexOf("bravo") < lines.at(-1).indexOf("charlie"));
  const footerY = lines.length - 1;
  assert.deepEqual(
    pane.handleMouse({
      type: "click",
      button: "left",
      x: lines[footerY].indexOf("alpha"),
      y: footerY,
    }),
    { handled: true },
  );
  assert.match(pane.render(160)[0], /alpha/);
  f.ports[0].callbacks.output(boundedOutput("streamed output", 1_048_576));
  wall = 900;
  widget.wake();
  assert.deepEqual(
    uiOrder(),
    [ids.alpha, ids.bravo, ids.charlie],
    "output and elapsed time do not reorder detail tabs",
  );
  assert.deepEqual(
    namesIn(component.render(160)),
    ["alpha", "charlie", "bravo"],
    "output and elapsed time do not reorder widget rows",
  );
  f.ports[0].finish("streamed output and result");
  await ended(f.controller, f.controller.findAgent("alpha"));
  widget.wake();
  assert.deepEqual(
    uiOrder(),
    [ids.alpha, ids.bravo, ids.charlie],
    "settlement does not reorder detail tabs",
  );
  assert.deepEqual(namesIn(component.render(160)), ["alpha", "charlie", "bravo"]);
  component.handleMouse(headingClick);
  assert.deepEqual(namesIn(component.render(160)), ["alpha", "charlie", "bravo"]);
  assert.deepEqual(ownerOrder(), [ids.alpha, ids.bravo, ids.charlie]);
  assert.deepEqual(await modelOrder(), ["alpha", "bravo", "charlie"]);
});
