import { ROW_BREAK, theme, owner, run, render, tool } from "../support/widget-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderWidget, renderWidgetLines } from "../../dist/orchestration/ui/agent-widget.js";
import {
  renderActivity,
  describeToolArgs,
  formatMs,
  formatTurns,
  shortPath,
  SPINNER,
} from "../../dist/orchestration/ui/format.js";
import { ChildActivity } from "../../dist/orchestration/runtime/activity-observer.js";

test("an empty, unblocked owner renders nothing at all", () => {
  const empty = { ...owner, resident: 0 };
  assert.deepEqual(render([], { owner: empty }), []);
  assert.deepEqual(
    render([run("a", { status: "completed" })], { owner: empty, shouldShowFinished: () => false }),
    [],
  );
});

test("the body is ordered finished, running, queued and the tree closes exactly once", () => {
  const lines = render(
    [
      run("q", { status: "queued" }),
      run("r", { status: "running", turn_elapsed_ms: 900 }),
      run("f", { status: "completed", name: "done" }),
    ],
    { owner: { ...owner, resident: 3 } },
  );
  assert.equal(lines[0], "▸ Subagents · ▹1 ◦1 ✓1");
  assert.match(lines[1], /^├─ ✓ done/);
  assert.match(lines[2], /^├─ ⠋ worker/);
  assert.match(lines[3], /^│ {4}⎿ {2}thinking…$/);
  assert.match(lines[4], /^└─ ◦ 1 queued$/);
  assert.equal(lines.filter((line) => line.startsWith("└─")).length, 1);
});

test("a trailing activity line hands its corner to the header above it", () => {
  const lines = render([run("r", { status: "running", name: "solo" })]);
  assert.deepEqual(lines.slice(1), [
    "└─ ⠋ solo (worker/d3) [m/high] → Task · ↻3≤256 · ▸2 · 12.4s",
    "   " + "  ⎿  thinking…",
  ]);
  assert.equal(lines.filter((line) => line.includes("│")).length, 0);
});

test("each lifecycle state keeps its own glyph, and finishing differs from cancelling", () => {
  const state = (overrides) => render([run("a", overrides)])[1];
  assert.match(state({ status: "completed" }), /^└─ ✓ /);
  assert.match(state({ status: "completed", limit_reached: true }), /^└─ ✓ .*· \(turn limit\)/);
  assert.match(state({ status: "needs_input", question: true }), /^└─ \? .*· needs answer\b/);
  assert.match(
    state({ status: "failed", error: "SESSION_UNAVAILABLE" }),
    /^└─ ✗ .*· failed: SESSION_UNAVAILABLE\b/,
  );
  assert.match(state({ status: "cancelled" }), /^└─ ■ .*· cancelled\b/);
  assert.match(state({ status: "running", finishing: true }), /· finishing\b/);
  assert.match(state({ status: "cancelling" }), /· cancelling\b/);
});

test("owner trouble is directly after the heading and survives an overflowing body", () => {
  const many = Array.from({ length: 9 }, (_, index) => run(`r${index}`, { status: "running" }));
  const lines = renderWidgetLines({
    runs: many,
    spinnerFrame: 0,
    width: 120,
    maxLines: 12,
    theme,
    shouldShowFinished: () => true,
    owner: { blocked: true, error: "PARENT_HISTORY_UNAVAILABLE", resident: 9, resident_limit: 9 },
  });
  // A running Agent costs two rows, so the last row can stay unused rather than half-drawn.
  assert(lines.length <= 12, String(lines.length));
  assert.equal(lines[0], "▸ Subagents (full) · ▹9");
  assert.match(lines[1], /^├─ ✗ owner blocked: PARENT_HISTORY_UNAVAILABLE$/);
  assert.match(lines.at(-1), /^└─ \+5 more \(5 running\)$/);
});

test("overflow keeps running work and reports what it hid", () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => run(`r${i}`, { status: "running" })),
    ...Array.from({ length: 4 }, (_, i) => run(`f${i}`, { status: "completed" })),
    run("q", { status: "queued" }),
  ];
  const lines = render(runs);
  assert.equal(lines.length, 12);
  assert.equal(lines.slice(1).filter((line) => /^[├└]─ ⠋ /.test(line)).length, 5);
  assert.match(lines.at(-1), /^└─ \+6 more \(1 running, 1 queued, 4 finished\)$/);
});

test("a single available row prioritizes the Owner warning over body or disclosure", () => {
  const frame = renderWidget({
    runs: [run("a", { status: "running" })],
    owner: { ...owner, blocked: true, error: "BROKEN" },
    maxLines: 1,
    expanded: true,
    width: 80,
    theme,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
  });
  assert.deepEqual(frame.lines, ["owner blocked: BROKEN"]);
  assert.deepEqual(frame.hits, [undefined]);
  assert.equal(frame.headingWidth, 0);
  assert.equal(frame.pagination, undefined);
});

test("resident headings remain discoverable without visible idle rows, even below capacity", () => {
  for (const beerMugs of [undefined, false, true])
    for (const resident of [1, 2, 7]) {
      const options = { beerMugs, owner: { ...owner, resident }, shouldShowFinished: () => false };
      assert.deepEqual(render([run("idle", { status: "completed" })], options), [
        `${beerMugs ? "🍺" : "▸"} Subagents · ✓1`,
      ]);
      assert.deepEqual(
        render([], options),
        [`${beerMugs ? "🍺" : "○"} Subagents`],
        "no runs means no disclosure, redundant total or dangling separator",
      );
    }
  for (const beerMugs of [false, true])
    for (const expanded of [false, true]) {
      assert.deepEqual(
        render([], {
          beerMugs,
          owner: { ...owner, resident: 0, blocked: true, error: "BROKEN" },
          expanded,
        }),
        [`${beerMugs ? "🍺" : "○"} Subagents`, "└─ ✗ owner blocked: BROKEN"],
        "blocked empty headings have no expansion or redundant total",
      );
    }
});

test("headings summarize all resident states, including aged-out terminal rows", () => {
  const runs = [
    run("running", { status: "running" }),
    run("finishing", { status: "running", finishing: true }),
    run("cancelling", { status: "cancelling" }),
    run("queued", { status: "queued" }),
    run("question", { status: "needs_input" }),
    run("done", { status: "completed" }),
    run("failed", { status: "failed" }),
    run("cancelled", { status: "cancelled" }),
  ];
  const options = { owner: { ...owner, resident: 8 }, shouldShowFinished: () => false };
  const lines = render(runs, options);
  assert.equal(lines[0], "▸ Subagents (full) · ?1 ▹3 ◦1 ✓1 ✗1 ■1");
  assert.doesNotMatch(lines.slice(1).join("\n"), /✓|✗|■|needs input/);
  for (const expanded of [false, true]) {
    assert.equal(
      render(runs, { ...options, width: 24, expanded })[0],
      `${expanded ? "▾" : "▸"} Subagents (full)`,
      "narrow fallback omits summary and separator",
    );
  }
  const terminal = [
    ...Array.from({ length: 10 }, (_, i) => run(`done-${i}`, { status: "completed" })),
    run("failed", { status: "failed" }),
    run("cancelled", { status: "cancelled" }),
  ];
  assert.deepEqual(
    render(terminal, {
      owner: { ...owner, resident: 12, resident_limit: 12 },
      shouldShowFinished: () => false,
    }),
    ["▸ Subagents (full) · ✓10 ✗1 ■1"],
  );
  const completed = terminal.map((row) => ({ ...row, status: "completed" }));
  const saturated = {
    owner: { ...owner, resident: 12, resident_limit: 12 },
    shouldShowFinished: () => false,
  };
  assert.deepEqual(render(completed, { ...saturated, disclosure: false, width: 20 }), [
    "○ Subagents (full)",
  ]);
  assert.deepEqual(render(completed, { ...saturated, maxLines: 1, width: 25 }), [
    "○ Subagents full · Alt+A",
  ]);
});

test("default disclosure arrows and opt-in mugs advertise only usable heading inspection", () => {
  const params = {
    runs: [run("idle", { status: "completed" })],
    owner,
    width: 120,
    maxLines: 13,
    theme,
    spinnerFrame: 0,
    shouldShowFinished: () => false,
  };
  for (const beerMugs of [undefined, false, true])
    for (const expanded of [false, true]) {
      const glyph = beerMugs ? (expanded ? "🍻" : "🍺") : expanded ? "▾" : "▸";
      const frame = renderWidget({ ...params, beerMugs, expanded });
      assert.equal(frame.lines[0], `${glyph} Subagents · ✓1`);
      assert.doesNotMatch(frame.lines[0], beerMugs ? /^[▸▾●○]|Subagents \d/ : /🍺|🍻|Subagents \d/);
      assert.equal(
        frame.headingWidth,
        visibleWidth(frame.lines[0]),
        "the entire heading remains clickable",
      );
      assert.deepEqual(frame.hits, expanded ? [undefined, "idle"] : [undefined]);
      for (const overrides of [
        { disclosure: false, owner: { ...owner, resident_limit: 2 } },
        { runs: [] },
        { width: 15 },
        { maxLines: 1 },
      ]) {
        const unavailable = renderWidget({ ...params, beerMugs, expanded, ...overrides });
        assert(unavailable.lines[0].startsWith(`${beerMugs ? "🍺" : "○"} Subagents`));
        assert.doesNotMatch(unavailable.lines[0], /[▸▾]|🍻/);
        assert.equal(unavailable.headingWidth, 0);
      }
      const busy = renderWidget({
        ...params,
        beerMugs,
        expanded,
        maxLines: 2,
        runs: [run("busy", { status: "running" })],
      });
      assert(busy.lines[0].startsWith(`${beerMugs ? "🍺" : "●"} Subagents`));
      assert.doesNotMatch(busy.lines[0], /[▸▾]|🍻/);
      assert.equal(
        busy.headingWidth,
        0,
        "a running pair with no control budget cannot advertise disclosure",
      );
    }
});

test("the beer-mug heading clips by terminal columns and retains capacity before summaries", () => {
  const runs = [run("a", { status: "completed" }), run("b", { status: "completed" })];
  const styled = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  for (const th of [theme, styled])
    for (const expanded of [false, true]) {
      for (const width of [1, 2, 3, 4, 5, 12, 15, 16, 17, 18, 19, 23, 24]) {
        const frame = renderWidget({
          runs,
          owner: { ...owner, resident: 12, resident_limit: 12 },
          width,
          theme: th,
          expanded,
          beerMugs: true,
          maxLines: 13,
          spinnerFrame: 0,
          shouldShowFinished: () => false,
        });
        const heading = stripTerminalSequences(frame.lines[0]);
        assert(
          frame.lines.every((line) => visibleWidth(line) <= width),
          `${width}: ${heading}`,
        );
        assert.doesNotMatch(
          heading,
          /\p{Surrogate}|\uFE0F/u,
          "clipping never splits the mug or adds a variation selector",
        );
        assert.doesNotMatch(
          heading,
          /^[▸▾●○]|Subagents \d/,
          "no obsolete prefix or standalone resident total",
        );
        if (width < 17) {
          assert.doesNotMatch(
            heading,
            /🍻/,
            "a capacity heading that cannot fit cannot advertise expansion",
          );
          assert.equal(frame.headingWidth, 0);
        } else {
          assert.equal(frame.headingWidth, visibleWidth(frame.lines[0]));
          const capacity = width < 19 ? "full" : "(full)";
          assert.equal(
            heading,
            `${expanded ? "🍻" : "🍺"} Subagents ${capacity}${width === 24 ? " · ✓2" : ""}`,
          );
        }
      }
    }
});

test("disclosure preflight uses the selected glyph width without redundant totals", () => {
  const runs = [run("a", { status: "completed" }), run("b", { status: "completed" })];
  for (const beerMugs of [undefined, false, true])
    for (const expanded of [false, true]) {
      const minimum = beerMugs ? 17 : 16,
        parenthesized = beerMugs ? 19 : 18;
      for (const width of [15, 16, 17, 18, 19]) {
        const frame = renderWidget({
          runs,
          owner: { ...owner, resident: 12, resident_limit: 12 },
          beerMugs,
          expanded,
          width,
          theme,
          maxLines: 13,
          spinnerFrame: 0,
          shouldShowFinished: () => false,
        });
        assert(frame.lines.every((line) => visibleWidth(line) <= width));
        assert.doesNotMatch(frame.lines[0], /Subagents \d/);
        if (width < minimum) {
          assert.equal(frame.headingWidth, 0);
          assert.doesNotMatch(frame.lines[0], /[▸▾]|🍻/);
        } else {
          const glyph = beerMugs ? (expanded ? "🍻" : "🍺") : expanded ? "▾" : "▸";
          assert.equal(
            frame.lines[0],
            `${glyph} Subagents ${width < parenthesized ? "full" : "(full)"}`,
          );
          assert.equal(frame.headingWidth, visibleWidth(frame.lines[0]));
        }
      }
    }
});

test("resident summaries use dim static active glyphs while body lifecycle glyphs keep their colors", () => {
  const paints = [],
    th = {
      fg: (color, text) => {
        paints.push([color, text]);
        return text;
      },
      bold: (text) => text,
    };
  const rows = [
    run("a", { status: "needs_input" }),
    run("b", { status: "running" }),
    run("c", { status: "queued" }),
    run("d", { status: "completed" }),
  ];
  assert.equal(
    render(rows, { owner: { ...owner, resident: 4 }, theme: th, spinnerFrame: 1 })[0],
    "▸ Subagents · ?1 ▹1 ◦1 ✓1",
  );
  for (const pair of [
    ["warning", "?1"],
    ["dim", "▹1"],
    ["muted", "◦1"],
    ["dim", "✓1"],
  ]) {
    assert(
      paints.some(([color, text]) => color === pair[0] && text === pair[1]),
      pair.join(":"),
    );
  }
  paints.length = 0;
  const blocked = render(rows, { theme: th, owner: { ...owner, blocked: true, error: "BROKEN" } });
  assert.match(blocked[0], /^▸ Subagents/);
  assert(paints.some(([color, text]) => color === "error" && text === "Subagents"));
  assert(paints.some(([color, text]) => color === "error" && text === "▸"));
  assert.match(blocked[1], /✗ owner blocked: BROKEN/);
  for (const [status, finishing, glyph, color] of [
    ["running", false, "⠙", "accent"],
    ["running", true, "⠙", "dim"],
    ["cancelling", false, "⠙", "warning"],
    ["queued", false, "◦", "muted"],
    ["completed", false, "✓", "success"],
    ["needs_input", false, "?", "warning"],
    ["failed", false, "✗", "error"],
    ["cancelled", false, "■", "dim"],
  ]) {
    paints.length = 0;
    render([run("state", { status, finishing })], { theme: th, spinnerFrame: 1, expanded: true });
    assert(
      paints.some(([tint, text]) => tint === color && text === glyph),
      `${status}/${finishing}`,
    );
  }
});

test("all spinner frames keep static active heading glyphs and disclosure fixed while Agent rows animate", () => {
  const rows = [run("busy", { status: "running" }), run("idle", { status: "completed" })];
  for (const expanded of [false, true]) {
    const disclosure = expanded ? "▾" : "▸",
      paints = [];
    const th = {
      fg: (color, text) => {
        paints.push([color, text]);
        return text;
      },
      bold: (text) => text,
    };
    const params = {
      runs: rows,
      owner,
      width: 120,
      maxLines: 13,
      expanded,
      theme: th,
      shouldShowFinished: () => true,
    };
    const first = renderWidget({ ...params, spinnerFrame: 0 });
    assert.equal(first.lines[0], `${disclosure} Subagents · ▹1 ✓1`);
    assert.equal(first.lines[0].indexOf(disclosure), 0);
    assert.equal(first.lines[0].split(" · ").length, 2, "one separator before the summary");
    for (const [spinnerFrame, glyph] of SPINNER.entries()) {
      paints.length = 0;
      const frame = renderWidget({ ...params, spinnerFrame });
      assert.equal(frame.lines[0], first.lines[0]);
      assert.equal(frame.headingWidth, first.headingWidth);
      assert.deepEqual(frame.hits, first.hits);
      assert(paints.some(([color, text]) => color === "dim" && text === "▹1"));
      assert(paints.some(([color, text]) => color === "dim" && text === " · "));
      assert.match(frame.lines[frame.hits.indexOf("busy")], new RegExp(`^[├└]─ ${glyph} `));
    }
    const settled = rows.map((row) => ({ ...row, status: "completed" }));
    assert.equal(
      renderWidget({ ...params, runs: settled, spinnerFrame: 1 }).lines[0],
      `${disclosure} Subagents · ✓2`,
    );
  }
});

test("expanded rendering pages every projected Agent within the bounded budget", () => {
  const finished = Array.from({ length: 12 }, (_, i) =>
    run(`idle-${i}`, { status: "completed", name: `idle${i}` }),
  );
  const runs = [...finished, run("busy", { status: "running", name: "busy" })];
  const params = {
    runs,
    owner: { ...owner, resident: 13, resident_limit: 16 },
    spinnerFrame: 0,
    width: 120,
    maxLines: 12,
    theme,
    shouldShowFinished: () => false,
  };
  const compact = renderWidget(params);
  assert.deepEqual(compact, renderWidget({ ...params, expanded: false }));
  assert.equal(compact.lines.length, 3, "ordinary rendering still filters aged-out results");
  assert.deepEqual(compact.hits, [undefined, "busy", "busy"]);
  assert.match(compact.lines[0], /^▸ Subagents/);
  const seen = new Set();
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ ...params, expanded: true, page });
    pages = frame.pagination.pages;
    assert.equal(frame.pagination.page, page);
    assert(frame.lines.length <= 12);
    assert.match(frame.lines[0], /^▾ Subagents/);
    for (const id of frame.hits.filter(Boolean)) seen.add(id);
    assert.doesNotMatch(frame.lines.join("\n"), /\+\d+ more/);
    assert(frame.lines.every((line) => visibleWidth(line) <= 120));
  }
  assert.deepEqual(
    [...seen],
    runs.map((row) => row.agent_id),
  );
});

test("expanded queued Agents each have their own clickable identity instead of an aggregate", () => {
  const queued = Array.from({ length: 13 }, (_, i) =>
    run(`queue-id-${i}`, { status: "queued", name: `queue${i}` }),
  );
  const params = {
    runs: queued,
    owner,
    spinnerFrame: 0,
    width: 120,
    theme,
    shouldShowFinished: () => false,
  };
  const compact = renderWidget(params);
  assert.deepEqual(compact.hits, [undefined, undefined]);
  assert.match(compact.lines[1], /^└─ ◦ 13 queued$/);
  const seen = [];
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({ ...params, expanded: true, page });
    pages = frame.pagination.pages;
    assert(frame.lines.length <= 6, "legacy/default rendering has a safe six-line budget");
    for (const [y, id] of frame.hits.entries())
      if (id) {
        const row = queued.find((run) => run.agent_id === id);
        assert.match(frame.lines[y], /^[├└]─ ◦ /);
        assert(frame.lines[y].includes(`${row.name} `));
        seen.push(id);
      }
    assert.doesNotMatch(frame.lines.join("\n"), /13 queued|\+\d+ more/);
  }
  assert.deepEqual(
    seen,
    queued.map((row) => row.agent_id),
  );
});

test("every expanded page protects owner trouble above the bounded body", () => {
  const runs = Array.from({ length: 8 }, (_, i) => run(`r${i}`, { status: "running" }));
  const seen = new Set();
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({
      runs,
      expanded: true,
      page,
      owner: { ...owner, blocked: true, error: "BROKEN" },
      spinnerFrame: 0,
      width: 80,
      theme,
      shouldShowFinished: () => false,
    });
    pages = frame.pagination.pages;
    assert(frame.lines.length <= 6);
    assert.match(frame.lines[1], /^├─ ✗ owner blocked: BROKEN$/);
    assert(
      frame.lines.some((line) => /⎿ {2}thinking…/.test(line)),
      "activity survives when a pair fits",
    );
    for (const id of frame.hits.filter(Boolean)) seen.add(id);
    assert(frame.lines.every((line) => visibleWidth(line) <= 80));
  }
  assert.deepEqual(
    [...seen],
    runs.map((row) => row.agent_id),
  );
});

test("every line fits the terminal, counting CJK by the columns it occupies", () => {
  const wide = "审查 controller.ts 的生命周期合同与取消语义，并核对结果分页";
  for (const width of [30, 46, 80]) {
    const lines = render(
      [
        run("a", {
          status: "running",
          name: "复核者",
          description: wide,
          preview: wide,
          active_tools: [{ name: "read", detail: "模块/家目录/极长的中文路径片段/controller.ts" }],
        }),
        run("b", { status: "failed", description: wide, error: wide }),
      ],
      { width },
    );
    for (const line of lines)
      assert(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${line}`);
  }
});

test("turns always carry their budget, written as upstream writes it", () => {
  assert.equal(formatTurns(3, 256), "↻3≤256");
  assert.equal(formatTurns(128, 256), "↻128≤256");
  assert.equal(formatTurns(0, 4), "↻0≤4");
});

test("both clocks show: time on the current turn beside the counter, total time last", () => {
  const live = render([
    run("a", { status: "running", name: "solo", turn_elapsed_ms: 2200, elapsed_ms: 12400 }),
  ])[1];
  assert.match(live, /↻3≤256 \(2\.2s\) · ▸2 · 12\.4s$/);
  // A settled Run has no current turn, so only the total remains.
  const done = render([
    run("a", { status: "completed", name: "solo", turn_elapsed_ms: 2200, elapsed_ms: 12400 }),
  ])[1];
  assert.match(done, /↻3≤256 · ▸2 · 12\.4s$/);
  const queued = render([
    run("a", { status: "queued", name: "solo" }),
    run("b", { status: "running" }),
  ])[3];
  assert.match(queued, /1 queued$/);
});

test("durations stay short below a minute and readable above it", () => {
  assert.equal(formatMs(0), "0.0s");
  assert.equal(formatMs(-5), "0.0s");
  assert.equal(formatMs(12400), "12.4s");
  assert.equal(formatMs(59949), "59.9s");
  assert.equal(formatMs(61500), "1m01s");
  assert.equal(formatMs(3_723_000), "62m03s");
});

test("production activity rendering prefers live tools, then the explicit output channel", () => {
  assert.equal(
    renderActivity(
      [tool("read", "src/core/controller.ts")],
      { preview: "ignored", channel: "text" },
      theme,
      72,
    ),
    "reading src/core/controller.ts",
  );
  assert.equal(renderActivity([tool("read")], { preview: "" }, theme, 72), "reading…");
  assert.equal(
    renderActivity([tool("bash", "npm test")], { preview: "" }, theme, 72),
    "running npm test",
  );
  assert.equal(
    renderActivity([tool("ask_parent", "which factor?")], { preview: "" }, theme, 72),
    "asking you: which factor?",
  );
  assert.equal(
    renderActivity([tool("alert_parent", "interface changed")], { preview: "" }, theme, 72),
    "alerting you: interface changed",
  );
  assert.equal(
    renderActivity([tool("mystery", "custom detail")], { preview: "" }, theme, 72),
    "mystery custom detail",
  );
  assert.equal(
    renderActivity([tool("read", "a.ts"), tool("edit", "b.ts")], { preview: "" }, theme, 72),
    "reading a.ts, editing b.ts",
  );
  assert.equal(
    renderActivity(
      [tool("grep", '"x"'), tool("grep", '"y"'), tool("read", "a")],
      { preview: "" },
      theme,
      72,
    ),
    "searching 2 patterns, reading…",
  );
  assert.equal(
    renderActivity(
      [tool("read", "a"), tool("read", "b"), tool("bash", "ls")],
      { preview: "" },
      theme,
      72,
    ),
    "reading 2 files, running…",
  );
  assert.equal(
    renderActivity(
      [],
      { preview: "\n\n  first real line \nlast real line \n  ", channel: "text" },
      theme,
      72,
    ),
    "replying: last real line",
  );
  assert.equal(
    visibleWidth(renderActivity([], { preview: "x".repeat(200), channel: "text" }, theme, 72)),
    72,
  );
  assert.equal(renderActivity([], { preview: "   \n " }, theme, 72), "thinking…");
});

/** The latest logical line stays left-anchored rather than sliding on each delta. */
test("the streamed preview holds still at its left edge as tokens arrive", () => {
  const child = new ChildActivity("/w");
  const handlers = new Map();
  child.extension({ on: (event, handler) => handlers.set(event, handler) });
  const message = { role: "assistant", content: [{ type: "text", text: "" }] };
  handlers.get("message_start")({ message });
  const stream = (delta) => {
    message.content[0].text += delta;
    handlers.get("message_update")({
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, partial: message, delta },
    });
  };
  stream("A line long enough to fill the preview window on its own.\n".repeat(6));
  const shown = [];
  for (const word of ["Now", " writing", " the", " newest", " line"]) {
    stream(word);
    shown.push(renderActivity([], child.snapshot(), theme, 72));
  }
  // Every frame starts the same way and only grows: nothing slid left.
  for (const [i, line] of shown.entries()) {
    assert.ok(
      line.startsWith("replying: Now"),
      `frame ${i} lost its left edge: ${JSON.stringify(line)}`,
    );
    if (i > 0)
      assert.ok(line.length >= shown[i - 1].length, `frame ${i} shrank: ${JSON.stringify(line)}`);
  }
  assert.equal(shown.at(-1), "replying: Now writing the newest line");
});

test("each tool contributes the argument that identifies its work, and nothing else", () => {
  const cwd = "/work/project",
    at = (name, args) => describeToolArgs(name, args, cwd, 72);
  assert.equal(
    at("read", { path: `${cwd}/src/core/controller.ts`, offset: 40, limit: 20 }),
    "src/core/controller.ts",
  );
  assert.equal(
    at("edit", {
      path: "src/ui/agent-widget.ts",
      edits: [{ oldText: "secret", newText: "other" }],
    }),
    "src/ui/agent-widget.ts",
  );
  assert.equal(at("write", { path: `${cwd}/out.txt`, content: "never rendered" }), "out.txt");
  assert.equal(at("ls", {}), ".");
  assert.equal(at("bash", { command: "npm  test\n  --silent" }), "npm test --silent");
  assert.equal(
    at("grep", { pattern: "createOwnerTools", path: `${cwd}/src` }),
    '"createOwnerTools" in src',
  );
  assert.equal(at("grep", { pattern: "x", glob: "**/*.ts" }), '"x" in **/*.ts');
  assert.equal(at("find", { pattern: "*.mjs" }), '"*.mjs"');
  assert.equal(
    at("ask_parent", { question: "What is the value of factor?" }),
    "What is the value of factor?",
  );
  assert.equal(at("alert_parent", { message: "interface changed" }), "interface changed");
  assert.equal(
    at("notify_parent", { message: "unsupported" }),
    undefined,
    "unsupported tools have no identifying preview",
  );
  // Absent, malformed and unknown inputs degrade to the bare verb, never to a crash.
  for (const args of [undefined, null, "string", 7, {}, { path: 3 }])
    assert.equal(at("read", args), undefined);
  assert.equal(at("mystery", { path: "a" }), undefined);
  assert.equal(renderActivity([{ name: "mystery" }], { preview: "" }, theme, 72), "mystery…");
});

test("a path that cannot fit keeps its tail, because the file name is the information", () => {
  const cwd = "/work/project",
    deep = `${cwd}/module/home/pi-resources/src/orchestration/core/controller.ts`;
  assert.equal(
    shortPath(deep, cwd, 72),
    "module/home/pi-resources/src/orchestration/core/controller.ts",
  );
  // Segments are added back from the tail while they fit; the next one up would be 34 columns.
  assert.equal(shortPath(deep, cwd, 30), "…/core/controller.ts");
  assert.equal(shortPath(deep, cwd, 40), "…/src/orchestration/core/controller.ts");
  for (const columns of [12, 24, 30, 40])
    assert(visibleWidth(shortPath(deep, cwd, columns)) <= columns);
  assert.equal(shortPath("/elsewhere/a.ts", cwd, 72), "/elsewhere/a.ts");
  assert(visibleWidth(shortPath(`${cwd}/${"n".repeat(90)}.ts`, cwd, 20)) <= 20);
});

test("pending alerts and recorded warnings are surfaced per Agent", () => {
  const line = render([
    run("a", { status: "needs_input", pending_messages: 2, has_run_warnings: true }),
  ])[1];
  assert.match(line, /run warning · 2 pending · needs input/);
  assert.ok(line.indexOf("run warning") < line.indexOf("↻"));
  assert.doesNotMatch(line, /dropped|never reached/);
  assert.doesNotMatch(render([run("a", { status: "completed" })])[1], /pending|warning/);
});

test("an Agent without a nickname is named by its profile, never labelled twice", () => {
  assert.match(
    render([run("a", { status: "completed" })])[1],
    /^└─ ✓ worker \(d3\) \[m\/high\] → Task/,
  );
  assert.match(
    render([run("a", { status: "completed", name: "scout" })])[1],
    /^└─ ✓ scout \(worker\/d3\) \[m\/high\] → Task/,
  );
  assert.match(
    render([run("a", { status: "completed", name: "editor" })])[1],
    /^└─ ✓ editor \(worker\/d3\)/,
    "a nickname is never relabelled as a profile",
  );
});

test("the widget shows every profile's admitted difficulty beside its nickname in every Run state", () => {
  const profiles = ["editor", "researcher"];
  const statuses = ["running", "completed", "failed"];
  for (const profile of profiles)
    for (const difficulty of [1, 2, 3, 4, 5])
      for (const status of statuses) {
        const row = run("a", { name: "orca", profile, difficulty, status }),
          before = structuredClone(row);
        const line = render([row])[1];
        const displayed =
          profile === "editor" ? "worker" : profile === "researcher" ? "scout" : profile;
        const identity = `orca${status === "failed" ? " · failed" : ""} (${displayed}/d${difficulty})`;
        assert.ok(line.includes(identity), `${status} ${profile}/d${difficulty}: ${line}`);
        assert.deepEqual(
          row,
          before,
          "display labels never rename the admitted or historical profile",
        );
      }

  const styled = {
    fg: (_color, text) => `\x1b[33m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  for (const width of [8, 16, 24, 40]) {
    const lines = render(
      [
        run("a", {
          name: "orca",
          profile: "researcher",
          difficulty: 5,
          status: "running",
          description: "Review source and tests",
        }),
      ],
      { width, theme: styled },
    );
    for (const line of lines)
      assert(visibleWidth(line) <= width, `${width}: ${visibleWidth(line)} ${line}`);
  }
});

test("a long nickname yields before the difficulty tag", () => {
  const line = render([run("a", { name: "n".repeat(32), status: "completed", description: "" })], {
    width: 40,
  })[1];
  assert.match(line, /\(worker\/d3\)/, line);
  assert.ok(visibleWidth(line) <= 40, line);
  assert.doesNotMatch(line, /n{32}/);
});

test("crowded 40/56-column warning rows keep a name prefix, complete tag and counted pending facts", () => {
  const styled = {
    fg: (color, text) =>
      `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : 90}m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  for (const width of [40, 56])
    for (const name of ["otter", "复核者", "复核审查者".repeat(8)]) {
      for (const status of ["completed", "failed"])
        for (const th of [theme, styled]) {
          const row = run("immutable-id", {
            name,
            profile: "editor",
            difficulty: 3,
            status,
            has_run_warnings: true,
            pending_messages: 1,
            error: "SDK broke: 失败说明".repeat(20),
          });
          const before = structuredClone(row);
          const frame = renderWidget({
            runs: [row],
            width,
            theme: th,
            owner,
            spinnerFrame: 0,
            shouldShowFinished: () => true,
          });
          const text = stripTerminalSequences(frame.lines[1]);
          assert(text.includes(name === "otter" ? "ott" : "复"), text);
          assert(text.includes("(worker/d3)"), text);
          const warning = text.match(/run warning|warn|!/)?.index;
          const pending = text.match(/1 pending|1pend/)?.index;
          assert.notEqual(warning, undefined, text);
          assert.notEqual(pending, undefined, text);
          assert(warning < pending, text);
          if (status === "failed") {
            assert.match(text, /failed/);
            assert(pending < text.indexOf("failed"), text);
            assert.doesNotMatch(text, /SDK broke: 失败说明SDK broke: 失败说明/);
          }
          for (const optional of ["[m/high]", "→", "↻"]) {
            if (text.includes(optional)) assert(pending < text.indexOf(optional), text);
          }
          assert.doesNotMatch(text, /dropped|lost|never reached/);
          if (th === styled)
            assert(
              ["run warning", "warn", "!"].some((signal) =>
                frame.lines[1].includes(styled.fg("error", signal)),
              ),
              frame.lines[1],
            );
          assert.equal(frame.hits[1], "immutable-id");
          assert.deepEqual(row, before);
          assert(frame.lines.every((line) => visibleWidth(line) <= width));
        }
    }
});

test("crowded attention retains questions, cancellation, finishing and turn limits before optional metadata", () => {
  for (const width of [40, 56])
    for (const [status, extra, state] of [
      ["needs_input", { question: true }, /needs answer|answer\?/],
      ["needs_input", { question: false }, /needs input|input\?/],
      ["cancelling", {}, /cancelling/],
      ["running", { finishing: true }, /finishing/],
      ["completed", { limit_reached: true }, /turn limit|limit/],
      ["cancelled", {}, /cancelled/],
    ]) {
      const frame = renderWidget({
        runs: [
          run("identity", {
            name: "otter",
            profile: "editor",
            difficulty: 3,
            status,
            ...extra,
            has_run_warnings: true,
            pending_messages: 1,
          }),
        ],
        width,
        theme,
        owner,
        spinnerFrame: 0,
        shouldShowFinished: () => true,
      });
      const text = stripTerminalSequences(frame.lines[1]);
      assert.match(text, /ot(?:t|…)/);
      assert.match(text, /\(worker\/d3\)/);
      assert.match(text, /run warning|warn|!/);
      assert.match(text, /1 pending|1pend/);
      assert.match(text, state);
      assert(text.search(/1 pending|1pend/) < text.search(state), text);
      assert.equal(frame.hits[1], "identity");
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
    }
});

test("wide attention wording and failed explanation stay unchanged", () => {
  for (const [status, state] of [
    ["completed", ""],
    ["failed", " · failed: SDK broke"],
  ]) {
    const line = render(
      [
        run("a", {
          name: "otter",
          profile: "editor",
          difficulty: 3,
          status,
          has_run_warnings: true,
          pending_messages: 1,
          error: "SDK broke",
        }),
      ],
      { width: 180 },
    )[1];
    assert.equal(
      line,
      `└─ ${status === "failed" ? "✗" : "✓"} otter · run warning · 1 pending${state} (worker/d3) [m/high] → Task · ↻3≤256 · ▸2 · 12.4s`,
    );
  }
});

test("impossible-width rows keep a nickname prefix before clipped attention and omit the whole tag", () => {
  for (const width of [8, 12, 20]) {
    const lines = render(
      [
        run("a", {
          name: "otter",
          profile: "researcher",
          difficulty: 5,
          status: "failed",
          has_run_warnings: true,
          pending_messages: 1,
          error: "Detailed failure",
        }),
      ],
      { width },
    );
    assert.match(lines[1], /^└─ ✗ o/);
    assert.doesNotMatch(lines[1], /\((?:scout|research)/);
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("a fixed nickname points to the current task, which can use more than forty columns", () => {
  const description = "Review GTK direct-entry safety after Windows foundation changes";
  for (const status of ["running", "completed"]) {
    const frame = renderWidget({
      runs: [run("orca-id", { name: "orca", status, description })],
      owner,
      spinnerFrame: 0,
      width: 180,
      theme,
      shouldShowFinished: () => true,
    });
    assert(
      frame.lines[1].includes(`orca (worker/d3) [m/high] → ${description} · ↻`),
      frame.lines[1],
    );
    assert.match(frame.lines[1], /▸2 · 12\.4s$/);
    assert.equal(
      frame.hits[1],
      "orca-id",
      "labels and their new separator never become click identities",
    );
    assert(frame.lines.every((line) => visibleWidth(line) <= 180));
  }
});

test("an absent task or insufficient room leaves no dangling task separator", () => {
  for (const description of ["", "  \n\t  "]) {
    assert.doesNotMatch(
      render([run("a", { status: "running", name: "orca", description })])[1],
      /→/,
    );
  }
  for (const width of [1, 10, 20]) {
    const lines = render(
      [run("a", { status: "running", name: "orca", description: "Review GTK" })],
      { width },
    );
    assert.doesNotMatch(lines[1], /→/);
    assert(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("tool counts use the compact tool-call glyph, including singular and zero", () => {
  for (const status of ["running", "completed"]) {
    for (const count of [0, 1, 77]) {
      const line = render([run("a", { status, tool_uses: count })])[1];
      if (count) assert.ok(line.includes(`▸${count}`));
      else assert.ok(!line.includes("▸"));
      assert.doesNotMatch(line, /tool uses?|tokens?/);
    }
  }
});

test("allocation labels preserve model IDs and show creation-time effort", () => {
  for (const model of [
    "gpt-5.6-sol",
    "fixture-strong-model",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "claude-opus-5",
    "qwen3.8:27b",
    "org/custom-model",
  ]) {
    for (const status of ["running", "completed"]) {
      assert.ok(
        render([run("a", { model, effort: "xhigh", status })])[1].includes(`[${model}/xhigh]`),
      );
    }
  }
});

test("context distinguishes unknown, zero and over-window snapshots and fits narrow rows", () => {
  for (const [tokens, percent] of [
    [null, "?"],
    [0, "0.0%"],
    [299200, "110.0%"],
  ]) {
    const a = run("a", {
      status: "running",
      model: "gpt-5.6-sol",
      runtime: { activity: "generating", context: { tokens, context_window: 272000 } },
    });
    assert.ok(render([a])[1].includes(`ctx ${percent}`));
    for (const width of [12, 40, 80]) {
      for (const line of render([a], { width })) assert.ok(visibleWidth(line) <= width);
    }
  }
  assert.doesNotMatch(
    render([run("a", { status: "running" })])[1],
    /ctx/,
    "no snapshot is not zero context",
  );
});

test("invalid direct-render context fixtures cannot print Infinity or NaN percentages", () => {
  const contexts = [0, -1, NaN, Infinity, 0.5].map((context_window) => ({
    tokens: 1000,
    context_window,
  }));
  contexts.push(...[-1, NaN, Infinity, 0.5].map((tokens) => ({ tokens, context_window: 272000 })));
  for (const context of contexts) {
    const line = render([
      run("a", { status: "running", runtime: { activity: "generating", context } }),
    ])[1];
    assert.ok(line.includes("ctx ?"), line);
    assert.doesNotMatch(line, /Infinity|NaN/);
  }
});

test("a long task yields to warnings and compact metrics at 120 and 160 columns", () => {
  const row = run("a", {
    status: "running",
    name: "reviewer",
    model: "gpt-5.6-sol",
    tool_uses: 77,
    description: "Review controller lifecycle and pending input ".repeat(10),
    cost: 0.5,
    pending_messages: 3,
    has_run_warnings: true,
    runtime: { activity: "generating", context: { tokens: 231000, context_window: 272000 } },
  });
  for (const width of [120, 160]) {
    const lines = render([row], { width });
    for (const text of [
      "reviewer",
      "[gpt-5.6-sol/high]",
      "run warning",
      "3 pending",
      "▸77",
      "ctx 84.9%",
      "$0.500",
      "12.4s",
    ]) {
      assert.ok(lines[1].includes(text), `${width}: missing ${text}: ${lines[1]}`);
    }
    assert.ok(lines[1].indexOf("run warning") < lines[1].indexOf("[gpt-5.6-sol/high]"));
    assert.doesNotMatch(lines[1], /token|tool use/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
});

test("long identities and diagnostics cannot hide warnings or pending alerts", () => {
  const styled = {
    fg: (_color, text) => `\x1b[33m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  for (const status of ["running", "failed", "needs_input", "cancelling", "completed"]) {
    for (const width of [80, 120, 160]) {
      for (const th of [theme, styled]) {
        const frame = renderWidget({
          runs: [
            run("a", {
              status,
              name: "审查\n".repeat(80),
              model: "gpt-5.6-sol",
              description: "Review the entire workspace ".repeat(50),
              pending_messages: 3,
              has_run_warnings: true,
              error: "SDK broke: ".repeat(40),
            }),
          ],
          width,
          owner,
          spinnerFrame: 0,
          theme: th,
          shouldShowFinished: () => true,
        });
        for (const text of ["run warning", "3 pending"])
          assert.ok(frame.lines[1].includes(text), frame.lines[1]);
        if (status === "failed") assert.ok(frame.lines[1].includes("failed: SDK broke"));
        if (status === "needs_input") assert.ok(frame.lines[1].includes("needs input"));
        if (status === "cancelling") assert.ok(frame.lines[1].includes("cancelling"));
        assert.equal(frame.hits[1], "a");
        assert.equal(frame.hits.length, frame.lines.length);
        for (const line of frame.lines) {
          assert.ok(visibleWidth(line) <= width);
          assert.doesNotMatch(line, ROW_BREAK);
        }
      }
    }
  }
});

test("cost is written the way Pi's own footer writes it, and is silent when nothing was reported", () => {
  const priced = render([run("a", { status: "running", cost: 1.2345 })])[1];
  assert.match(priced, /\$1\.234/);
  const unpriced = render([run("b", { status: "running" })])[1];
  assert.ok(!unpriced.includes("$"), "an unpriced Run shows no cost rather than $0.000");
  // A measured zero is a fact, not a missing one, and reads differently.
  assert.match(render([run("c", { status: "running", cost: 0 })])[1], /\$0\.000/);
});

test("suppressing mouse-only idle headings preserves attention facts", () => {
  const options = { disclosure: false, shouldShowFinished: () => false };
  assert.deepEqual(render([run("idle", { status: "completed" })], options), []);
  assert.deepEqual(
    render([run("idle", { status: "completed" })], {
      ...options,
      owner: { ...owner, blocked: true, error: "BROKEN" },
    }),
    ["○ Subagents · ✓1", "└─ ✗ owner blocked: BROKEN"],
  );
  assert.match(render([run("busy", { status: "running" })], options)[1], /⠋/);
  assert.match(
    render([run("asked", { status: "needs_input" })], {
      ...options,
      shouldShowFinished: (_id, status) => status === "needs_input",
    })[1],
    /needs input/,
  );
});
