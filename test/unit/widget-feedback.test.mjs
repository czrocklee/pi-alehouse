import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderWidget } from "../../dist/orchestration/ui/agent-widget.js";
import { formatMs } from "../../dist/orchestration/ui/format.js";
import { headingClick, mounted, owner, run, theme, viewOf } from "../support/widget-fixture.mjs";

const frame = (runs, options = {}) =>
  renderWidget({
    runs,
    owner,
    theme,
    width: 160,
    maxLines: 6,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
    ...options,
  });
const styled = {
  fg: (color, text) => `\x1b[${color === "warning" ? 33 : 36}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

test("aged warnings and five reached limits cannot displace live work after twelve parent turns", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const views = [
    { ...viewOf("warning", "completed"), name: "old-warning", cleanup_errors: ["RECORDED_ISSUE"] },
    ...Array.from({ length: 5 }, (_, index) => ({
      ...viewOf(`limited-${index}`, "completed"),
      name: `old-limit-${index}`,
      outcome: { status: "completed", limit_reached: true },
    })),
    { ...viewOf("live", "running"), name: "live-identity", turn_elapsed_ms: 61_000 },
  ];
  const before = structuredClone(views),
    h = mounted(views);
  t.after(() => h.widget.dispose());
  h.tui.terminal.rows = 18;
  h.widget.wake();
  for (let turn = 0; turn < 12; turn++) h.widget.onTurnStart();
  const lines = h.lines();
  assert.equal(lines.length, 3);
  assert.match(lines[1], /live-identity/);
  assert.match(lines[2], /1m01s thinking…$/);
  assert.doesNotMatch(lines.join("\n"), /\bturn /);
  assert.doesNotMatch(lines.slice(1).join("\n"), /old-warning|old-limit|run warning|turn limit/);
  assert.equal(h.widget.agents().length, 7, "ageing is presentation, not resident release");
  h.tui.terminal.rows = 48;
  h.lines();
  h.component().handleMouse(headingClick);
  const inspected = h.lines().join("\n");
  assert.match(inspected, /old-warning/);
  for (let index = 0; index < 5; index++) assert(inspected.includes(`old-limit-${index}`));
  assert.match(inspected, /turn limit reached/);
  assert.deepEqual(views, before, "history flags and Owner state are never acknowledged by paint");
});

test("questions and pending alerts persist through ageing and inspection without UI acknowledgement", (t) => {
  const views = [
    {
      ...viewOf("question", "needs_input"),
      name: "asked",
      outcome: { status: "needs_input", question: "Which choice?" },
    },
    { ...viewOf("pending", "completed"), name: "pending", pending_messages: 2 },
  ];
  const before = structuredClone(views),
    h = mounted(views),
    opened = [];
  t.after(() => h.widget.dispose());
  h.widget.onOpen((id) => opened.push(id));
  h.widget.wake();
  for (let turn = 0; turn < 12; turn++) h.widget.onTurnStart();
  for (let inspection = 0; inspection < 2; inspection++) {
    const lines = h.lines();
    assert.match(lines[1], /asked .*needs answer/);
    assert.match(lines[2], /pending .*2 pending/);
    for (const y of [1, 2]) {
      assert.deepEqual(h.component().handleMouse({ ...headingClick, y }), { handled: true });
    }
    h.component().handleMouse(headingClick);
  }
  assert.deepEqual(opened, ["question", "pending", "question", "pending"]);
  assert.deepEqual(views, before);
});

test("overflow reserves a live identity despite arbitrarily many questions and pending rows", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => run(`question-${i}`, { status: "needs_input" })),
    ...Array.from({ length: 3 }, (_, i) =>
      run(`pending-${i}`, { status: "completed", pending_messages: 1 }),
    ),
    run("live", { status: "running", name: "live-identity", turn_elapsed_ms: 60_000 }),
  ];
  for (const maxLines of [4, 6]) {
    const result = frame(rows, { maxLines, shouldShowFinished: () => false });
    assert(result.hits.includes("live"), result.lines.join("\n"));
    assert.match(result.lines[result.hits.indexOf("live")], /live-identity.*1m00s/);
    assert.doesNotMatch(result.lines.join("\n"), /\bturn /);
    const shownQuestions = result.hits.filter((id) => id?.startsWith("question-")).length;
    assert.match(result.lines.at(-1), new RegExp(`${8 - shownQuestions} needs input, 3 attention`));
    assert.equal(result.hits.at(-1), undefined);
    assert.equal(result.lines.length, maxLines);
  }
  const single = frame(rows, { maxLines: 3, shouldShowFinished: () => false });
  assert.deepEqual(single.hits, [undefined, "question-0", undefined]);
  assert.match(single.lines.at(-1), /\+11 more \(7 needs input, 1 running, 3 attention\)$/);
});

test("turn-limit observations coexist with every lifecycle status, including real failures", () => {
  const limits = /\((?:turn limit reached|limit)\)$/;
  for (const [status, extra, lifecycle, compact] of [
    ["running", {}, undefined, undefined],
    ["running", { finishing: true }, "finishing", "finish"],
    ["cancelling", {}, "cancelling", "cancel"],
    ["queued", {}, "queued", "queued"],
    ["completed", {}, undefined, undefined],
    ["needs_input", { question: true }, "needs answer", "answer?"],
    ["cancelled", {}, "cancelled", "cancel"],
    ["failed", { error: "SDK_BROKE" }, "failed", "failed"],
  ]) {
    for (const width of [40, 56, 120, 180]) {
      for (const th of [theme, styled]) {
        const row = run("immutable-id", { status, name: "otter", limit_reached: true, ...extra }),
          before = structuredClone(row),
          result = frame([row], { width, theme: th });
        const text = stripTerminalSequences(result.lines[1]);
        // At 40, icon+otter+tag+gap+(finish/cancel/queued/failed)+(limit)
        // uses all 37 body cells. answer? needs one more, so only its name
        // shortens to ott…; a Task fragment must not displace either identity.
        const omitTitle = width === 40 && lifecycle !== undefined;
        const name = omitTitle && status === "needs_input" ? "ott…" : "otter";
        assert(text.includes(`${name}${width < 83 ? " (worker/d3)" : "  worker/d3"}`), text);
        if (omitTitle) {
          assert.doesNotMatch(text, /Task|T…/, text);
          assert(text.endsWith(`(${compact}) (limit)`), text);
          assert.equal(visibleWidth(text), 40, "the protected fields fit exactly");
        } else {
          assert(text.includes("Task"), `${status}/${width}: ${text}`);
          assert(text.indexOf("Task") < text.search(limits), text);
          if (lifecycle) assert(text.indexOf("Task") < text.indexOf(lifecycle), text);
        }
        assert.match(text, width >= 120 ? /\(turn limit reached\)$/ : limits);
        assert.equal((text.match(/\((?:turn limit reached|limit)\)/g) ?? []).length, 1);
        if (lifecycle) {
          const label = width === 40 ? compact : lifecycle;
          assert(text.includes(label), `${status}/${width}: ${text}`);
          assert(text.indexOf(label) < text.search(limits), text);
        }
        assert.equal(result.hits[1], "immutable-id");
        assert(result.lines.every((line) => visibleWidth(line) <= width));
        assert.deepEqual(row, before);
      }
    }
  }
});

test("four running Agents in six lines retain each turn clock exactly once after previews yield", () => {
  const rows = [59_900, 60_000, 61_500, 90_000].map((turn_elapsed_ms, index) =>
    run(`live-${index}`, {
      status: "running",
      name: `live${index}`,
      turn_elapsed_ms,
      description: "Review the lifecycle and cancellation boundaries",
      tool_uses: 777,
      cost: 0.27,
      runtime: { activity: "generating", context: { tokens: 950, context_window: 1000 } },
    }),
  );
  for (const width of [40, 80, 160]) {
    const paints = [],
      th = {
        ...styled,
        fg: (color, text) => {
          paints.push([color, text]);
          return styled.fg(color, text);
        },
      },
      result = frame(rows, { width, theme: th });
    assert.equal(result.lines.length, 6);
    assert.equal(result.hits.filter(Boolean).length, 5, "four headers and one optional preview");
    const plain = result.lines.map(stripTerminalSequences),
      all = plain.join("\n");
    for (const [index, row] of rows.entries()) {
      const clock = formatMs(row.turn_elapsed_ms);
      assert.equal(all.split(clock).length - 1, 1, `${width}: ${all}`);
      const header = plain[result.hits.indexOf(row.agent_id)];
      assert(header.includes(row.name));
      assert.equal(
        header.includes(clock),
        index > 0,
        "the surviving preview owns only its own clock",
      );
      assert.equal(
        paints.some(([color, text]) => color === "warning" && text.trim() === clock),
        index > 0,
      );
    }
    assert(result.lines.every((line) => visibleWidth(line) <= width));
  }
});

test("tiny expanded pages put clocks on headers and retain roster-wide anchors across all pages", () => {
  const rows = [900, 61_500, 3_723_000].map((turn_elapsed_ms, index) =>
    run(`page-${index}`, {
      status: "running",
      name: index === 2 ? "long-review-identity" : `p${index}`,
      description: "Review task",
      turn_elapsed_ms,
      turns: index === 2 ? 120 : 3,
    }),
  );
  const taskStarts = new Set(),
    clockEnds = new Set();
  for (let page = 0; page < rows.length; page++) {
    const result = frame(rows, { expanded: true, maxLines: 3, page }),
      line = result.lines[1],
      clock = formatMs(rows[page].turn_elapsed_ms);
    assert.equal(result.pagination.pages, rows.length);
    assert.deepEqual(result.hits, [undefined, rows[page].agent_id, undefined]);
    assert.equal(result.lines.join("\n").split(clock).length - 1, 1);
    assert(line.includes(clock));
    assert.doesNotMatch(line, /⎿/);
    taskStarts.add(visibleWidth(line.slice(0, line.indexOf("Review task"))));
    clockEnds.add(visibleWidth(line.slice(0, line.indexOf(clock) + clock.length)));
    assert(result.lines.every((text) => visibleWidth(text) <= 160));
  }
  assert.equal(taskStarts.size, 1);
  assert.equal(clockEnds.size, 1);
});

test("header-only and ordinary pages suppress clocks for exited, finishing and non-running work", () => {
  const rows = [
    run("exited", { status: "running", execution_exited: true }),
    run("finishing", { status: "running", finishing: true }),
    run("cancelling", { status: "cancelling" }),
    run("done", { status: "completed" }),
  ].map((row) => ({ ...row, turn_elapsed_ms: 61_500 }));
  for (const expanded of [false, true]) {
    for (const maxLines of [3, 13]) {
      for (let page = 0, pages = 1; page < pages; page++) {
        const result = frame(rows, { expanded, maxLines, page });
        pages = result.pagination?.pages ?? 1;
        assert.doesNotMatch(result.lines.join("\n"), /1m01s|\bturn /);
        assert(result.lines.every((line) => visibleWidth(line) <= 160));
      }
    }
  }
});

test("expired compact metadata cannot alter the eligible roster grid or force shared fallback", () => {
  const live = run("live", { status: "running", name: "复核者", description: "Review task" }),
    history = run("expired", {
      status: "failed",
      name: "very-long-historical-identity".repeat(3),
      model: "long-model".repeat(30),
      description: "Old task".repeat(100),
      has_run_warnings: true,
      limit_reached: true,
      turns: 987654,
      max_turns: 1234567,
      tool_uses: 987654,
      cost: 987654.32,
      runtime: { activity: "idle", context: { tokens: 123456, context_window: 1 } },
    });
  for (const width of [83, 100, 160]) {
    for (const th of [theme, styled]) {
      const options = { width, theme: th, shouldShowFinished: () => false },
        baseline = frame([live], options),
        result = frame([live, history], options);
      assert.deepEqual(result.lines.slice(1), baseline.lines.slice(1));
      assert.deepEqual(result.hits, baseline.hits);
      assert(result.lines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("collapsed queued identities and metadata cannot size painted compact headers", () => {
  const live = run("live", { status: "running", name: "复核者", description: "Review task" });
  const queued = run("queued", {
    status: "queued",
    name: "very-long-queued-identity".repeat(3),
    model: "hidden-model".repeat(20),
    tool_uses: 9999,
    cost: 0.29,
    runtime: { activity: "idle", context: { tokens: 1000, context_window: 1000 } },
  });
  const before = structuredClone([live, queued]);
  for (const width of [83, 100, 160]) {
    for (const th of [theme, styled]) {
      const options = { width, theme: th };
      const baseline = frame([live], options);
      const result = frame([live, queued], options);
      const header = (result) => stripTerminalSequences(result.lines[1]).slice(3);
      assert.equal(header(result), header(baseline), "only the tree branch may change");
      assert.match(header(result), /m\/high/);
      assert.doesNotMatch(header(result), /—|hidden-model|\$/);
      assert.match(stripTerminalSequences(result.lines.at(-1)), /◦ 1 queued$/);
      assert.deepEqual(result.hits, [undefined, "live", "live", undefined]);
      assert.doesNotMatch(
        stripTerminalSequences(result.lines[0]),
        /latest|Σ|\$/,
        "heading omits spend even when aggregated queued tasks have prices",
      );
      assert(result.lines.every((line) => visibleWidth(line) <= width));
    }
  }
  assert.deepEqual([live, queued], before);
});

test("overflow-only metadata cannot add compact columns, while expanded pages share the full roster", () => {
  const rows = [
    run("live", {
      status: "running",
      name: "复核者",
      description: "Review task",
      turn_elapsed_ms: 61_000,
    }),
    run("visible", { status: "completed", name: "done", description: "Review task" }),
    run("hidden", { status: "completed", name: "h", description: "Review task" }),
    run("hidden-peer", { status: "completed", name: "p", description: "Review task" }),
  ];
  const changed = rows.map((row) =>
    row.agent_id !== "hidden"
      ? row
      : {
          ...row,
          name: "long-hidden-identity".repeat(3),
          model: "hidden-model".repeat(20),
          cost: 0.29,
          tool_uses: 9999,
          runtime: { activity: "idle", context: { tokens: 123456, context_window: 1000 } },
        },
  );
  const before = structuredClone(changed);
  for (const width of [83, 100, 160]) {
    for (const th of [theme, styled]) {
      const options = { width, theme: th, maxLines: 4 };
      const baseline = frame(rows, options);
      const result = frame(changed, options);
      assert.deepEqual(result.lines.slice(1), baseline.lines.slice(1));
      assert.deepEqual(result.hits, [undefined, "live", "visible", undefined]);
      assert.match(stripTerminalSequences(result.lines.at(-1)), /\+2 more \(2 finished\)$/);
      assert.doesNotMatch(stripTerminalSequences(result.lines[1]), /—|\$/);
      assert.doesNotMatch(stripTerminalSequences(result.lines[0]), /latest|Σ|\$/);
      assert(result.lines.every((line) => visibleWidth(line) <= width));
    }
  }
  const starts = new Set(),
    costEnds = new Set(),
    seen = new Set();
  for (let page = 0, pages = 1; page < pages; page++) {
    const result = frame(changed, { width: 180, maxLines: 4, expanded: true, page });
    pages = result.pagination.pages;
    for (const [index, id] of result.hits.entries()) {
      if (!id) continue;
      const line = stripTerminalSequences(result.lines[index]);
      if (line.includes("⎿")) continue;
      seen.add(id);
      starts.add(visibleWidth(line.slice(0, line.indexOf("Review task"))));
      const cost = line.match(/(?:\$0\.29|—)(?= +12\.4s +Review task$)/);
      assert(cost, line);
      costEnds.add(visibleWidth(line.slice(0, cost.index + cost[0].length)));
      if (id === "hidden") assert.match(line, /\$0\.29/);
    }
    assert(result.lines.every((line) => visibleWidth(line) <= 180));
  }
  assert.deepEqual(
    [...seen],
    changed.map((row) => row.agent_id),
  );
  assert.equal(starts.size, 1, "expanded task anchors are page-independent");
  assert.equal(costEnds.size, 1, "expanded missing-price cells retain the shared cost column");
  assert.deepEqual(changed, before);
});
