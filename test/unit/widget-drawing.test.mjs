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
  formatCost,
  formatContextPercent,
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

test("the body is ordered running, queued, ordinary terminal and the tree closes exactly once", () => {
  const lines = render(
    [
      run("q", { status: "queued" }),
      run("r", { status: "running", turn_elapsed_ms: 900 }),
      run("f", { status: "completed", name: "done" }),
    ],
    { owner: { ...owner, resident: 3 } },
  );
  assert.equal(lines[0], "▸ Subagents · ▹1 ◦1 ✓1");
  assert.match(lines[1], /^├─ ⠋ worker/);
  assert.match(lines[2], /^│ {4}⎿ {2}0\.9s thinking…$/);
  assert.match(lines[3], /^├─ ◦ 1 queued$/);
  assert.match(lines[4], /^└─ ✓ done/);
  assert.equal(lines.filter((line) => line.startsWith("└─")).length, 1);
});

test("a trailing activity line hands its corner to the header above it", () => {
  const lines = render([run("r", { status: "running", name: "solo" })]);
  assert.match(lines[1], /^└─ ⠋ solo {2}worker\/d3 {2}m\/high {2}↻3\/256 +12\.4s {2}Task$/);
  assert.equal(lines[2], "   " + "  ⎿  thinking…");
  assert.equal(lines.filter((line) => line.includes("│")).length, 0);
});

test("each lifecycle state keeps its own glyph, and finishing differs from cancelling", () => {
  const state = (overrides) => render([run("a", overrides)])[1];
  assert.match(state({ status: "completed" }), /^└─ ✓ /);
  assert.match(state({ status: "completed", limit_reached: true }), /^└─ ✓ .*turn limit reached/);
  assert.match(state({ status: "needs_input", question: true }), /^└─ \? .*needs answer\b/);
  assert.match(
    state({ status: "failed", error: "SESSION_UNAVAILABLE" }),
    /^└─ ✗ .*failed: SESSION_UNAVAILABLE\b/,
  );
  assert.match(state({ status: "cancelled" }), /^└─ ■ .*cancelled\b/);
  assert.match(state({ status: "running", finishing: true }), /finishing\b/);
  assert.match(state({ status: "cancelling" }), /cancelling\b/);
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
  assert(lines.length <= 12, String(lines.length));
  assert.equal(lines[0], "▸ Subagents (full) · ▹9");
  assert.match(lines[1], /^├─ ✗ owner blocked: PARENT_HISTORY_UNAVAILABLE$/);
  assert.equal(lines.filter((line) => /^[├└]─ ⠋ /.test(line)).length, 9);
  assert.doesNotMatch(
    lines.join("\n"),
    /\+\d+ more/,
    "optional previews yield to active identities",
  );
});

test("optional activity yields when the complete compact roster can fit", () => {
  const runs = [
    ...Array.from({ length: 6 }, (_, i) => run(`r${i}`, { status: "running" })),
    ...Array.from({ length: 4 }, (_, i) => run(`f${i}`, { status: "completed" })),
    run("q", { status: "queued" }),
  ];
  const lines = render(runs);
  assert.equal(lines.length, 12);
  assert.equal(lines.slice(1).filter((line) => /^[├└]─ ⠋ /.test(line)).length, 6);
  assert.equal(lines.filter((line) => /^[├└]─ ✓ /.test(line)).length, 4);
  assert(lines.some((line) => /1 queued$/.test(line)));
  assert.doesNotMatch(lines.join("\n"), /\+\d+ more/);
});

test("compact and expanded rosters share a stable question, live, attention, queued, failure, finished order", () => {
  const rows = [
    run("done", { status: "completed" }),
    run("busy-a", { status: "running" }),
    run("failed", { status: "failed" }),
    run("queued", { status: "queued" }),
    run("warned", { status: "completed", has_run_warnings: true }),
    run("busy-b", { status: "cancelling" }),
    run("question", { status: "needs_input" }),
    run("pending", { status: "completed", pending_messages: 2 }),
    run("cancelled", { status: "cancelled" }),
  ];
  const expected = ["question", "busy-a", "busy-b", "warned", "pending"];
  for (const expanded of [false, true]) {
    const seen = [];
    for (let page = 0, pages = 1; page < pages; page++) {
      const frame = renderWidget({
        runs: rows,
        owner,
        theme,
        width: 160,
        maxLines: 13,
        spinnerFrame: 0,
        expanded,
        page,
        shouldShowFinished: () => true,
      });
      pages = frame.pagination?.pages ?? 1;
      for (const id of frame.hits.filter(Boolean)) if (!seen.includes(id)) seen.push(id);
      if (!expanded) {
        const queued = frame.lines.findIndex((line) => /1 queued$/.test(line));
        const terminal = frame.hits.indexOf("done");
        assert(queued > frame.hits.lastIndexOf("busy-b"));
        assert(terminal > queued);
        assert.equal(frame.hits[queued], undefined, "the compact queued count stays inert");
      }
    }
    assert.deepEqual(seen, [
      ...expected,
      ...(expanded ? ["queued"] : []),
      "failed",
      "done",
      "cancelled",
    ]);
  }
});

test("only questions and pending alerts bypass terminal ageing; queued alerts remain clickable", () => {
  const rows = [
    run("idle", { status: "completed" }),
    run("warned", { status: "completed", has_run_warnings: true }),
    run("pending", { status: "completed", pending_messages: 2 }),
    run("limited", { status: "completed", limit_reached: true }),
    run("asked", { status: "needs_input" }),
    run("queued-alert", { status: "queued", name: "alerted", pending_messages: 1 }),
    run("queued-ordinary", { status: "queued" }),
  ];
  const frame = renderWidget({
    runs: rows,
    owner,
    theme,
    width: 160,
    maxLines: 13,
    spinnerFrame: 0,
    shouldShowFinished: () => false,
  });
  assert.deepEqual(frame.hits.filter(Boolean), ["asked", "pending", "queued-alert"]);
  assert.doesNotMatch(frame.lines.slice(1).join("\n"), /run warning|turn limit/);
  assert.match(frame.lines[frame.hits.indexOf("queued-alert")], /◦ alerted .*1 pending/);
  const aggregate = frame.lines.findIndex((line) => /1 queued$/.test(line));
  assert(aggregate > frame.hits.indexOf("queued-alert"));
  assert.equal(frame.hits[aggregate], undefined);
});

test("overflow sacrifices previews before attention or active identities and accounts for every hidden row", () => {
  const rows = [
    run("done", { status: "completed" }),
    run("busy-a", { status: "running" }),
    run("question", { status: "needs_input", question: true }),
    run("queue", { status: "queued" }),
    run("busy-b", { status: "cancelling" }),
    run("failed", { status: "failed", error: "BROKEN" }),
    run("busy-c", { status: "running" }),
  ];
  const frame = renderWidget({
    runs: rows,
    owner,
    theme,
    width: 120,
    maxLines: 7,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
  });
  assert.deepEqual(frame.hits.filter(Boolean), ["question", "busy-a", "busy-b", "busy-c"]);
  assert(frame.lines.some((line) => /1 queued$/.test(line)));
  assert.match(frame.lines.at(-1), /\+2 more \(1 failed, 1 finished\)$/);
  assert.match(frame.lines[0], /\?1 ▹3 ◦1 ✓1 ✗1/);
  assert.equal(frame.hits.at(-1), undefined);
  assert.equal(frame.lines.length, 7);
  assert.equal(frame.hits.length, frame.lines.length);
});

test("overflow labels hidden questions, failures and attention rather than calling them finished", () => {
  const frame = renderWidget({
    runs: [
      run("asked-a", { status: "needs_input" }),
      run("asked-b", { status: "needs_input" }),
      run("failed", { status: "failed", limit_reached: true }),
      run("warned", { status: "completed", has_run_warnings: true }),
      run("busy", { status: "running" }),
      run("queued", { status: "queued" }),
      run("done", { status: "completed" }),
    ],
    owner,
    theme,
    width: 160,
    maxLines: 3,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
  });
  assert.deepEqual(frame.hits, [undefined, "busy", undefined]);
  assert.match(
    frame.lines[2],
    /\+6 more \(2 needs input, 1 attention, 1 queued, 1 failed, 1 finished\)$/,
  );
});

test("40-column overflow preserves every hidden attention category without ellipsis", () => {
  const frame = renderWidget({
    runs: [
      run("asked", { status: "needs_input" }),
      run("failed", { status: "failed" }),
      run("pending", { status: "completed", pending_messages: 1 }),
    ],
    owner,
    theme,
    width: 40,
    maxLines: 2,
    spinnerFrame: 0,
    shouldShowFinished: () => true,
  });
  const overflow = stripTerminalSequences(frame.lines[1]);
  assert.match(overflow, /\+3(?: more)?/);
  assert.match(overflow, /input1|\?1|1 needs input/);
  assert.match(overflow, /fail1|✗1|1 failed/);
  assert.match(overflow, /attn1|!1|1 attention/);
  assert.doesNotMatch(overflow, /…/);
  assert.deepEqual(frame.hits, [undefined, undefined]);
  assert(frame.lines.every((line) => visibleWidth(line) <= 40));
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
  assert.match(lines.slice(1).join("\n"), /needs input/);
  assert.doesNotMatch(lines.slice(1).join("\n"), /✓|✗|■/);
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

test("resident summaries accent static active counts while body lifecycle glyphs keep their colors", () => {
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
    ["accent", "▹1"],
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
      assert(paints.some(([color, text]) => color === "accent" && text === "▹1"));
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
  assert.deepEqual([...seen], ["busy", ...finished.map((row) => row.agent_id)]);
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

test("shared turn formatting retains its full-precision detail convention", () => {
  assert.equal(formatTurns(3, 256), "↻3≤256");
  assert.equal(formatTurns(128, 256), "↻128≤256");
  assert.equal(formatTurns(0, 4), "↻0≤4");
});

test("the current-turn clock prefixes activity, while total duration remains in the roster", () => {
  const live = render([
    run("a", { status: "running", name: "solo", turn_elapsed_ms: 15600, elapsed_ms: 12400 }),
  ]);
  assert.match(live[1], /↻3\/256/);
  assert.match(live[1], /12\.4s {2}Task$/);
  assert.doesNotMatch(live[1], /15\.6s/);
  assert.match(live[2], /15\.6s thinking…$/);
  assert.doesNotMatch(live.join("\n"), /\bturn /);
  // A settled Run has no current turn, so only the total remains.
  const done = render([
    run("a", { status: "completed", name: "solo", turn_elapsed_ms: 15600, elapsed_ms: 12400 }),
  ]);
  assert.match(done[1], /↻3\/256/);
  assert.match(done[1], /12\.4s {2}Task$/);
  assert.doesNotMatch(done.join("\n"), /15\.6s|turn /);
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
  assert.equal(at("bash", { command: "npm  test\n  --silent" }), "npm  test\\n  --silent");
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
  assert.match(line, /Task \(run warning · 2 pending · needs input\)$/);
  assert.ok(line.indexOf("run warning") < line.indexOf("needs input"));
  assert.ok(line.indexOf("Task") < line.indexOf("run warning"), "attention merges after the title");
  assert.doesNotMatch(line, /dropped|never reached/);
  assert.doesNotMatch(render([run("a", { status: "completed" })])[1], /pending|warning/);
});

test("an Agent without a nickname is named by its profile, never labelled twice", () => {
  assert.match(
    render([run("a", { status: "completed" })])[1],
    /^└─ ✓ worker {2}d3 {2}m\/high {2}↻3\/256 +12\.4s {2}Task$/,
  );
  assert.match(
    render([run("a", { status: "completed", name: "scout" })])[1],
    /^└─ ✓ scout {2}worker\/d3 {2}m\/high {2}↻3\/256 +12\.4s {2}Task$/,
  );
  assert.match(
    render([run("a", { status: "completed", name: "editor" })])[1],
    /^└─ ✓ editor {2}worker\/d3/,
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
        assert.match(
          line,
          new RegExp(`orca {2}${displayed}/d${difficulty} {2}`),
          `${status} ${profile}/d${difficulty}: ${line}`,
        );
        if (status === "failed") assert.match(line, /failed/);
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
          // Merged attention trails the identity and any surviving optional metadata.
          assert(warning > text.indexOf(name === "otter" ? "ott" : "复"), text);
          if (status === "failed") {
            assert.match(text, /failed/);
            assert(pending < text.indexOf("failed"), text);
            assert.doesNotMatch(text, /SDK broke: 失败说明SDK broke: 失败说明/);
          }
          for (const optional of ["[m/high]", "→", "↻"]) {
            if (text.includes(optional)) assert(text.indexOf(optional) < warning, text);
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

test("crowded attention retains lifecycle facts, with turn limits trailing the task before optional metadata", () => {
  for (const width of [40, 56])
    for (const [status, extra, nameAt40, stateAt40, stateAt56] of [
      ["needs_input", { question: true }, "ott…", "answer?", "needs answer"],
      ["needs_input", { question: false }, "otter", "input?", "needs input"],
      ["cancelling", {}, "otter", "cancel", "cancelling"],
      ["running", { finishing: true }, "otter", "finish", "finishing"],
      ["completed", { limit_reached: true }, "ott…", "", ""],
      ["cancelled", {}, "otter", "cancel", "cancelled"],
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
      const state = width === 40 ? stateAt40 : stateAt56;
      const facts = `${width === 40 ? "! 1pend" : "warn 1 pending"}${state ? ` ${state}` : ""}`;
      const suffix = `(${facts})${extra.limit_reached ? " (limit)" : ""}`;
      if (width === 40) {
        // No header clock is supplied. Complete facts and identity fit exactly;
        // an optional title must not displace the name/tag or become a fragment.
        assert.equal(text.slice(5), `${nameAt40} (worker/d3)  ${suffix}`, text);
        assert.equal(visibleWidth(text), 40, text);
      } else {
        assert(text.includes("otter (worker/d3)  "), text);
        assert(text.endsWith(suffix), text);
      }
      assert.match(text, /run warning|warn|!/);
      assert.match(text, /1 pending|1pend/);
      if (state) {
        assert(text.includes(state), text);
        assert(text.search(/1 pending|1pend/) < text.indexOf(state), text);
      } else {
        assert(text.search(/1 pending|1pend/) < text.indexOf("(limit)"), text);
      }
      if (extra.limit_reached) assert.match(text, /\((?:turn limit reached|limit)\)$/);
      assert.equal(frame.hits[1], "identity");
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
    }
});

test("wide attention retains full wording and failed explanation in the task column", () => {
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
    assert.match(line, /^└─ [✗✓] otter {2}worker\/d3 {2}m\/high {2}/);
    const group = `run warning · 1 pending${state}`;
    assert(line.includes(`Task (${group})`), line);
    assert.match(line, /↻3\/256 +12\.4s/);
    assert.match(line, /Task \([^()]*\)$/);
    assert.doesNotMatch(line, /▸\d/);
  }
});

test("120-column failure rows retain the wrapped SDK cause before optional metadata", () => {
  const error = "Error: SESSION_UNAVAILABLE (sdk_error): Error: SDK broke";
  const palettes = [
    theme,
    {
      fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    },
  ];
  for (const palette of palettes)
    for (const flagged of [false, true]) {
      const width = flagged ? 160 : 120;
      const row = run("released-failure", {
        status: "failed",
        resident: false,
        model: "controlled",
        effort: "off",
        description: "Check diagnostics",
        error,
        turns: 1,
        elapsed_ms: 0,
        has_run_warnings: flagged,
        pending_messages: flagged ? 2 : 0,
      });
      const frame = renderWidget({
        runs: [row],
        owner: { ...owner, resident: 0 },
        theme: palette,
        width,
        maxLines: 6,
        spinnerFrame: 0,
        shouldShowFinished: () => true,
      });
      const text = stripTerminalSequences(frame.lines[1]);
      assert.match(text, /failed: Error: SESSION_UNAVAILABLE \(sdk_error\): Error: SDK broke/);
      assert.match(text, /Check diagno(?:stics|…)/);
      assert(text.indexOf("Check diagno") < text.indexOf("failed:"), text);
      if (width === 120)
        assert.doesNotMatch(
          text,
          /controlled\/off/,
          "optional model yields before the identifying cause",
        );
      if (flagged) assert.match(text, /run warning · 2 pending · failed/);
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
      assert.equal(frame.hits[1], "released-failure");
      assert.equal(row.error, error, "display allocation never changes the retained diagnostic");
    }
});

test("failure explanations remain bounded without displacing complete attention facts or the trailing task", () => {
  const error = "x".repeat(500);
  const lines = render(
    [
      run("failure", {
        status: "failed",
        error,
        has_run_warnings: true,
        pending_messages: 2,
        limit_reached: true,
        description: "Check diagnostics",
      }),
    ],
    { width: 240 },
  );
  const text = stripTerminalSequences(lines[1]);
  assert.match(text, /run warning · 2 pending · failed: x+…/);
  assert.doesNotMatch(text, /x{61}/, "failure detail keeps its existing 60-cell ceiling");
  assert.match(
    text,
    /Check diagnostics \(run warning · 2 pending · failed: x+…\) \(turn limit reached\)$/,
  );
  assert.equal(text.split("turn limit reached").length - 1, 1);
  assert(lines.every((line) => visibleWidth(line) <= 240));
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
    assert.match(frame.lines[1], /^└─ . orca {2}worker\/d3 {2}m\/high {2}↻3\/256 +12\.4s {2}/);
    assert(frame.lines[1].endsWith(description), frame.lines[1]);
    assert.doesNotMatch(frame.lines[1], /▸\d/);
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

test("tool counts are absent from Agent headers without changing the observations", () => {
  for (const status of ["running", "completed"]) {
    for (const count of [0, 1, 77]) {
      const row = run("a", { status, tool_uses: count });
      const line = render([row])[1];
      assert.doesNotMatch(line, /▸\d|tool uses?|tokens?/);
      assert.equal(row.tool_uses, count);
      assert.match(line, /Task$/);
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
        render([run("a", { model, effort: "xhigh", status })], { width: 180 })[1].includes(
          `${model}/xhigh`,
        ),
      );
    }
  }
});

test("context distinguishes unknown, zero and over-window snapshots and fits narrow rows", () => {
  for (const [tokens, percent] of [
    [null, "?"],
    [0, "0%"],
    [299200, "110%"],
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
    for (const text of ["reviewer", "run warning", "3 pending", "ctx 85%", "$0.50", "12.4s"]) {
      assert.ok(lines[1].includes(text), `${width}: missing ${text}: ${lines[1]}`);
    }
    assert.equal(lines[1].includes("gpt-5.6-sol/high"), width === 160, `${width}: ${lines[1]}`);
    assert.ok(lines[1].indexOf("run warning") < lines[1].indexOf("3 pending"));
    assert.doesNotMatch(lines[1], /▸77/);
    assert.match(stripTerminalSequences(lines[1]), /Review.*… \(run warning · 3 pending\)$/);
    const title = stripTerminalSequences(lines[1]).match(
      /(Review.*…) \(run warning · 3 pending\)$/,
    )?.[1];
    assert.ok(title && visibleWidth(title) >= 24, `${width}: title needs 24 cells before facts`);
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
        assert.match(frame.lines[1], /run warning|warn|!/);
        assert.match(frame.lines[1], /3 pending|3pend/);
        if (status === "failed") {
          assert.ok(frame.lines[1].includes("failed"), frame.lines[1]);
          if (width >= 160) assert.ok(frame.lines[1].includes("failed: SDK broke"), frame.lines[1]);
        }
        if (status === "needs_input") assert.match(frame.lines[1], /needs input|input\?/);
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

test("widget costs use cents while preserving missing, zero and partial observations", () => {
  for (const [cost, cost_partial, expected] of [
    [1.2345, false, "$1.23"],
    [0.27, false, "$0.27"],
    [0, false, "$0.00"],
    [0.0042, false, "<$0.01"],
    [0.27, true, "≥$0.27"],
  ]) {
    const line = render([run("a", { status: "running", cost, cost_partial })])[1];
    assert(line.includes(expected), line);
    assert.doesNotMatch(line, /\$\d+\.\d{3}/);
  }
  const unpriced = render([run("b", { status: "running" })])[1];
  assert.ok(!unpriced.includes("$"), "an unpriced Run does not invent a measured zero");
});

test("wide roster columns align by terminal cells across variable, CJK and ANSI rows", () => {
  const rows = [
    run("short", {
      status: "completed",
      name: "a",
      model: "m",
      effort: "off",
      description: "Task one",
      turns: 3,
      max_turns: 256,
      tool_uses: 2,
      cost: 0.27,
      elapsed_ms: 12400,
      runtime: { activity: "idle", context: { tokens: 267, context_window: 1000 } },
    }),
    run("wide", {
      status: "completed",
      name: "复核者",
      profile: "researcher",
      difficulty: 5,
      model: "fixture-long-model",
      effort: "xhigh",
      description: "核对任务",
      turns: 120,
      max_turns: 1024,
      tool_uses: 77,
      cost: 12.3,
      elapsed_ms: 3723000,
      runtime: { activity: "idle", context: { tokens: 1000, context_window: 1000 } },
    }),
    run("ansi", {
      status: "completed",
      name: "rev\x1b[31mbot",
      model: "other",
      effort: "high",
      description: "Task three",
      turns: 0,
      max_turns: 8,
      tool_uses: 1,
      cost: 0,
      elapsed_ms: 1000,
      runtime: { activity: "idle", context: { tokens: 0, context_window: 1000 } },
    }),
  ];
  const styled = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
    bold: (text) => `\x1b[1m${text}\x1b[0m`,
  };
  const before = structuredClone(rows);
  for (const width of [160, 200]) {
    let plain;
    for (const th of [theme, styled]) {
      const frame = renderWidget({
        runs: rows,
        owner,
        theme: th,
        width,
        maxLines: 13,
        spinnerFrame: 0,
        shouldShowFinished: () => true,
      });
      const body = frame.lines.slice(1).map(stripTerminalSequences);
      if (plain) assert.deepEqual(body, plain, "trusted ANSI cannot affect column allocation");
      else plain = body;
      assert.deepEqual(
        frame.hits.slice(1),
        rows.map((row) => row.agent_id),
      );
      assert(frame.lines.every((line) => visibleWidth(line) <= width));
      const position = (text, token, edge = "start") => {
        const index = text.indexOf(token);
        assert(index >= 0, `missing ${token}: ${text}`);
        return visibleWidth(text.slice(0, index)) + (edge === "end" ? visibleWidth(token) : 0);
      };
      const columns = [
        ["worker/d3", "scout/d5", "worker/d3"],
        ["m/off", "fixture-long-model/xhigh", "other/high"],
        ["Task one", "核对任务", "Task three"],
      ];
      for (const tokens of columns)
        assert.equal(
          new Set(body.map((line, i) => position(line, tokens[i]))).size,
          1,
          tokens.join(", "),
        );
      // Labeled metrics keep the label at the shared left edge and
      // right-align the numeric value inside the same column width.
      const labeled = [
        {
          prefix: "↻",
          raw: ["↻3/256", "↻120/1024", "↻0/8"],
          values: ["3/256", "120/1024", "0/8"],
        },
        {
          prefix: "ctx ",
          raw: ["ctx 27%", "ctx 100%", "ctx 0%"],
          values: ["27%", "100%", "0%"],
        },
      ];
      for (const { prefix, values } of labeled) {
        assert.equal(
          new Set(body.map((line) => position(line, prefix))).size,
          1,
          `${prefix} labels share a left edge`,
        );
        assert.equal(
          new Set(body.map((line, i) => position(line, values[i], "end"))).size,
          1,
          `${prefix} values share a right edge`,
        );
      }
      const metrics = [
        ["$0.27", "$12.30", "$0.00"],
        ["12.4s", "62m03s", "1.0s"],
      ];
      for (const tokens of metrics)
        assert.equal(
          new Set(body.map((line, i) => position(line, tokens[i], "end"))).size,
          1,
          tokens.join(", "),
        );
      // Painted labeled cells pad internally between label and value.
      const painted = labeled.map(({ prefix, raw, values }) => {
        const cellWidth = Math.max(...raw.map(visibleWidth));
        return values.map(
          (value) => prefix + " ".repeat(cellWidth - visibleWidth(prefix + value)) + value,
        );
      });
      for (const [i, line] of body.entries()) {
        assert(
          visibleWidth(line) < width,
          "natural trailing task width leaves unused terminal columns at the far right",
        );
        assert.doesNotMatch(line, /▸\d/);
        assert.doesNotMatch(line, /[()[\]→]| · /, line);
        const fields = [...columns.slice(0, 2), ...painted, ...metrics, columns[2]].map(
          (tokens) => tokens[i],
        );
        for (let column = 0; column < fields.length - 1; column++) {
          const gap = line.slice(
            line.indexOf(fields[column]) + fields[column].length,
            line.indexOf(fields[column + 1]),
          );
          assert.match(gap, /^ {2,}$/, `two-space column separator: ${JSON.stringify(gap)}`);
        }
      }
    }
  }
  assert.deepEqual(rows, before, "alignment never rewrites admitted or usage facts");
});

test("83-column mixed attention rows choose grid or fallback for the whole roster", () => {
  const rows = [
    run("ordinary", { status: "completed", name: "short", cost: 1.23 }),
    run("attention", {
      status: "cancelling",
      name: "复核".repeat(6),
      has_run_warnings: true,
      pending_messages: 12,
      cost: 1.23,
    }),
    run("active", { status: "running", name: "active" }),
  ];
  for (const th of [
    theme,
    {
      fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    },
  ]) {
    const frame = renderWidget({
      runs: rows,
      owner,
      theme: th,
      width: 83,
      maxLines: 13,
      spinnerFrame: 0,
      shouldShowFinished: () => true,
    });
    const headers = ["attention", "active", "ordinary"].map((id) =>
      stripTerminalSequences(frame.lines[frame.hits.indexOf(id)]),
    );
    const fallback = headers.map((line) => line.includes("(worker/d3)"));
    assert.equal(new Set(fallback).size, 1, headers.join("\n"));
    for (const line of headers) assert.match(line, /worker\/d3/);
    assert.match(headers[0], /run warning|warn|!/);
    assert.match(headers[0], /12 pending|12pend/);
    assert.match(headers[0], /cancelling/);
    if (!fallback[0]) {
      const anchors = headers.map((line) => visibleWidth(line.slice(0, line.indexOf("worker/d3"))));
      assert.equal(new Set(anchors).size, 1);
    }
    assert(frame.lines.every((line) => visibleWidth(line) <= 83));
  }
});

test("pagination and missing observations preserve roster-wide column anchors without invented zeroes", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    run(`page-${index}`, {
      status: "completed",
      name: index === 7 ? "long-review-name" : `p${index}`,
      description: "Review task",
      turns: index === 7 ? 120 : 3,
      max_turns: 256,
      tool_uses: index === 7 ? 77 : 2,
      cost: index === 0 ? undefined : index === 1 ? 0 : 0.27,
      runtime:
        index === 0
          ? undefined
          : { activity: "idle", context: { tokens: 267, context_window: 1000 } },
    }),
  );
  const starts = new Set(),
    turnStarts = new Set(),
    ends = new Set(),
    seen = [];
  for (let page = 0, pages = 1; page < pages; page++) {
    const frame = renderWidget({
      runs: rows,
      owner,
      theme,
      width: 160,
      maxLines: 5,
      expanded: true,
      page,
      spinnerFrame: 0,
      shouldShowFinished: () => false,
    });
    pages = frame.pagination.pages;
    for (const [index, id] of frame.hits.entries()) {
      if (!id) continue;
      const line = frame.lines[index];
      starts.add(visibleWidth(line.slice(0, line.indexOf("Review task"))));
      // The label keeps the column's left edge; find the numeric end past
      // the internal padding a wider sibling page introduces.
      const turn = line.match(/↻ *\d+\/256/);
      assert(turn, line);
      turnStarts.add(visibleWidth(line.slice(0, turn.index)));
      ends.add(visibleWidth(line.slice(0, turn.index + turn[0].length)));
      if (id === "page-0") {
        assert.doesNotMatch(line, /\$|ctx/, "missing observations are not measured zeroes");
        assert.match(line, /—/);
      }
      if (id === "page-1") assert.match(line, /\$0\.00(?!\d)/);
      seen.push(id);
    }
  }
  assert.deepEqual(
    seen,
    rows.map((row) => row.agent_id),
  );
  assert.equal(
    starts.size,
    1,
    "a longer identity on a later page sets the task anchor on every page",
  );
  assert.equal(turnStarts.size, 1, "turn markers share their left edge across all pages");
  assert.equal(ends.size, 1, "larger later-page turn values set a shared metric width");
});

test("responsive columns shed model and context before useful trailing task space", () => {
  const row = run("responsive", {
    status: "completed",
    name: "long-review-name",
    model: "fixture-long-model",
    effort: "xhigh",
    description: "Review lifecycle transitions and accounting",
    turns: 3,
    max_turns: 256,
    tool_uses: 77,
    cost: 12.3,
    elapsed_ms: 3723000,
    runtime: { activity: "idle", context: { tokens: 1000, context_window: 1000 } },
  });
  for (const width of [160, 100, 83, 80, 56, 40, 20]) {
    const frame = renderWidget({
      runs: [row],
      owner,
      theme,
      width,
      spinnerFrame: 0,
      shouldShowFinished: () => true,
    });
    const line = stripTerminalSequences(frame.lines[1]);
    assert.equal(frame.hits[1], "responsive");
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
    if (width >= 83) {
      assert.match(line, /long-review-name {2}worker\/d3/);
      assert.match(line, /Review/);
      assert.match(line, /↻3\/256/);
      assert.match(line, /\$12\.30/);
      assert.match(line, /62m03s +Review/);
      assert.doesNotMatch(line, /[()[\]→]/);
      assert.equal(line.includes("fixture-long-model/xhigh"), width === 160);
      assert.doesNotMatch(line, /▸77/);
      assert.equal(line.includes("ctx 100%"), width > 83);
    } else if (width >= 40) {
      assert.match(
        line,
        /\(worker\/d3\)/,
        "tight fallback retains the complete profile/difficulty tag",
      );
    }
  }
});

test("60-column rows retain a recognizable task and omit whole optional metrics rather than clipping values", () => {
  for (const status of ["running", "completed"])
    for (const [turns, tokens] of [
      [3, 850],
      [220, 950],
    ]) {
      const row = run("tight-task", {
        status,
        name: "orca",
        description: "Review GTK direct-entry safety after foundation changes",
        model: "fixture-long-model",
        effort: "xhigh",
        turns,
        max_turns: 256,
        tool_uses: 777,
        cost: 0.27,
        elapsed_ms: 12400,
        runtime: { activity: "generating", context: { tokens, context_window: 1000 } },
      });
      const frame = renderWidget({
        runs: [row],
        owner,
        theme,
        width: 60,
        spinnerFrame: 0,
        shouldShowFinished: () => true,
      });
      const line = stripTerminalSequences(frame.lines[1]);
      assert.match(line, /orca/);
      assert.match(line, /\(worker\/d3\)/);
      assert.match(line, /Review GTK/, line);
      if (line.includes(".4s")) assert.match(line, /12\.4s.*Review GTK/, line);
      if (line.includes("↻")) assert(line.includes(`↻${turns}/256`), line);
      assert.doesNotMatch(line, /▸777/);
      if (line.includes("ctx")) assert(line.includes(`ctx ${tokens / 10}%`), line);
      if (line.includes("$")) assert.match(line, /\$0\.27(?!\d)/);
      assert.doesNotMatch(line, /(?:↻\d*\/?\d*|▸\d*|ctx \d*%?|\$[\d.]*)…/);
      assert.equal(frame.hits[1], "tight-task");
      assert(frame.lines.every((text) => visibleWidth(text) <= 60));
    }
});

test("widget metric severity uses observed thresholds, and rounding never crosses one", () => {
  for (const [tokens, turns, contextColor, turnsColor, shown] of [
    [699, 79, "dim", "dim", 69],
    [700, 80, "warning", "warning", 70],
    [899, 99, "warning", "warning", 89],
    [900, 100, "error", "warning", 90],
    [996, 100, "error", "warning", 100],
  ]) {
    const paints = [];
    const th = {
      fg: (color, text) => {
        paints.push([color, text.trim()]);
        return text;
      },
      bold: theme.bold,
    };
    render(
      [
        run("threshold", {
          status: "completed",
          turns,
          max_turns: 100,
          runtime: { activity: "idle", context: { tokens, context_window: 1000 } },
        }),
      ],
      { width: 160, theme: th },
    );
    assert(
      paints.some(([color, text]) => color === contextColor && text === `ctx ${shown}%`),
      JSON.stringify(paints),
    );
    assert(
      paints.some(([color, text]) => color === turnsColor && text === `↻${turns}/100`),
      JSON.stringify(paints),
    );
  }
});

test("widget rounding does not change shared detail and accounting formatters", () => {
  assert.equal(formatTurns(3, 256), "↻3≤256");
  assert.equal(formatCost(0.27), "$0.270");
  assert.equal(formatContextPercent({ tokens: 267, context_window: 1000 }), "26.7%");
  const line = render([
    run("rounded", {
      status: "running",
      cost: 0.27,
      runtime: { activity: "generating", context: { tokens: 267, context_window: 1000 } },
    }),
  ])[1];
  assert.match(line, /↻3\/256/);
  assert.match(line, /ctx 27%/);
  assert.match(line, /\$0\.27(?!\d)/);
});

test("headings omit all aggregate spend while per-Agent prices retain partial and unknown semantics", () => {
  const rows = [
    run("a", { status: "running", cost: 0.12 }),
    run("b", { status: "completed", cost: 0.15 }),
    run("released", { status: "failed", resident: false, cost: 99 }),
    run("partial", { status: "completed", cost: 0.279, cost_partial: true }),
    run("zero", { status: "completed", cost: 0 }),
    run("unknown", { status: "completed" }),
  ];
  for (const expanded of [false, true]) {
    const frame = renderWidget({
      runs: rows,
      owner,
      theme,
      width: 180,
      maxLines: 13,
      expanded,
      spinnerFrame: 0,
      shouldShowFinished: () => true,
    });
    assert.doesNotMatch(frame.lines[0], /latest|Σ|\$|lifetime/);
    assert.match(frame.lines[0], /▹1 ✓4/);
    for (const [id, price] of [
      ["a", "$0.12"],
      ["b", "$0.15"],
      ["released", "$99.00"],
      ["partial", "≥$0.27"],
      ["zero", "$0.00"],
    ]) {
      assert(frame.lines[frame.hits.indexOf(id)].includes(price), id);
    }
    const unknown = frame.lines[frame.hits.indexOf("unknown")];
    assert.doesNotMatch(unknown, /\$/);
    assert.match(unknown, /—/);
  }
  assert.doesNotMatch(render(rows, { shouldShowFinished: () => false })[0], /latest|Σ|\$/);
  assert.doesNotMatch(render([rows[2]], { owner: { ...owner, resident: 0 } })[0], /latest|Σ|\$/);
});

test("turn clocks identify turn time before tool or thinking previews and warn at one minute", () => {
  for (const [turn_elapsed_ms, expected, warning] of [
    [59900, "59.9s ", false],
    [60000, "1m00s ", true],
    [61500, "1m01s ", true],
  ]) {
    for (const activity of [
      { active_tools: [tool("read", "src/a.ts")] },
      { thinking: "considering lifecycle", channel: "thinking" },
    ]) {
      const paints = [];
      const th = {
        fg: (color, text) => {
          paints.push([color, text]);
          return text;
        },
        bold: theme.bold,
      };
      const lines = render([run("clock", { status: "running", turn_elapsed_ms, ...activity })], {
        theme: th,
      });
      assert(lines[2].includes(expected), lines[2]);
      assert.doesNotMatch(lines.join("\n"), /\bturn /);
      assert.match(lines[2], / (?:reading src\/a\.ts|thinking: considering lifecycle)$/);
      assert.doesNotMatch(lines[2], / · /, "the compact activity gap is one plain space");
      assert.doesNotMatch(lines[1], /turn |59\.9s|1m00s|1m01s/);
      assert.equal(
        paints.some(([color, text]) => color === "warning" && text.includes(expected.trim())),
        warning,
        `${turn_elapsed_ms}: ${JSON.stringify(paints)}`,
      );
      for (const width of [20, 40, 80])
        assert(
          render([run("clock", { status: "running", turn_elapsed_ms, ...activity })], {
            width,
          }).every((line) => visibleWidth(line) <= width),
        );
    }
  }
});

test("fixed metadata precedes trailing labels without stretching to ultrawide terminal edges", () => {
  const rows = [
    run("cjk", {
      status: "completed",
      name: "复核🦉",
      profile: "researcher",
      difficulty: 5,
      model: "fixture",
      effort: "xhigh",
      description: "核对任务",
      turns: 120,
      max_turns: 1024,
      tool_uses: 999,
      cost: 1.159,
      cost_partial: true,
      runtime: { activity: "idle", context: { tokens: 900, context_window: 1000 } },
    }),
    run("ascii", {
      status: "completed",
      name: "a",
      description: "Review",
      turns: 0,
      max_turns: 8,
      cost: 0,
      runtime: { activity: "idle", context: { tokens: 0, context_window: 1000 } },
    }),
  ];
  const palettes = [
    theme,
    {
      fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
      bold: (text) => `\x1b[1m${text}\x1b[0m`,
    },
  ];
  let baseline;
  for (const width of [160, 240, 400])
    for (const palette of palettes) {
      const frame = renderWidget({
        runs: rows,
        owner,
        theme: palette,
        width,
        maxLines: 13,
        spinnerFrame: 0,
        shouldShowFinished: () => true,
      });
      const body = frame.lines.slice(1).map(stripTerminalSequences);
      if (baseline)
        assert.deepEqual(body, baseline, "extra viewport space never pads internal columns");
      else baseline = body;
      assert.deepEqual(frame.hits.slice(1), ["cjk", "ascii"]);
      assert.doesNotMatch(frame.lines[0], /latest|Σ|\$/);
      for (const [index, line] of body.entries()) {
        const tokens =
          index === 0
            ? [
                "复核🦉",
                "scout/d5",
                "fixture/xhigh",
                "↻",
                "120/1024",
                "ctx",
                "90%",
                "≥$1.15",
                "12.4s",
                "核对任务",
              ]
            : ["a", "worker/d3", "m/high", "↻", "0/8", "ctx", "0%", "$0.00", "12.4s", "Review"];
        let after = 0;
        for (const token of tokens) {
          const at = line.indexOf(token, after);
          assert(at >= after, `${token}: ${line}`);
          after = at + token.length;
        }
        assert(line.endsWith(rows[index].description), line);
        assert(visibleWidth(line) < 120, "short labels leave surplus width at the far right");
        assert.doesNotMatch(line, /▸\d/);
        assert.match(line, /12\.4s {2}(?:核对任务|Review)$/, "no flex-width hole before the label");
      }
      const taskStarts = body.map((line, index) =>
        visibleWidth(line.slice(0, line.indexOf(rows[index].description))),
      );
      assert.equal(
        taskStarts[0],
        taskStarts[1],
        "CJK/emoji names do not move the shared task anchor",
      );
    }
});

test("long trailing labels use remaining width without an arbitrary label cap in grid and fallback", () => {
  const description = "Review lifecycle and cancellation boundaries ".repeat(20);
  for (const width of [40, 56, 83, 120, 240]) {
    const row = run("long-label", {
      status: "completed",
      name: "orca",
      description,
      cost: 0.279,
      cost_partial: true,
    });
    const frame = renderWidget({
      runs: [row],
      owner,
      theme,
      width,
      spinnerFrame: 0,
      shouldShowFinished: () => true,
    });
    const header = stripTerminalSequences(frame.lines[1]);
    assert.match(header, /Review.*…$/);
    const start = header.indexOf("Review");
    for (const token of ["worker/d3", "m/high", "↻", "$", "12.4s"])
      if (header.includes(token)) assert(header.indexOf(token) < start, header);
    if (width === 240) assert(visibleWidth(header.slice(start)) > 72);
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
    assert.equal(frame.hits[1], "long-label");
    assert.doesNotMatch(header, /▸\d/);
    assert.equal(row.description, description);
  }
});

test("merged task attention keeps the shared trailing task start without a quiet-row hole", () => {
  const rows = [
    run("ordinary", { status: "completed", name: "calm", description: "Review task" }),
    run("pending", {
      status: "completed",
      name: "news",
      description: "Review task",
      pending_messages: 2,
    }),
  ];
  for (const width of [83, 120, 200]) {
    const frame = renderWidget({
      runs: rows,
      owner,
      theme,
      width,
      maxLines: 6,
      spinnerFrame: 0,
      shouldShowFinished: () => true,
    });
    const headers = rows.map((row) =>
      stripTerminalSequences(frame.lines[frame.hits.indexOf(row.agent_id)]),
    );
    const starts = headers.map((line) => visibleWidth(line.slice(0, line.indexOf("Review task"))));
    assert.equal(starts[0], starts[1]);
    assert.match(headers[0], /Review task$/);
    assert.match(headers[1], /Review task \(2 pending\)$/);
    assert.doesNotMatch(
      headers[0],
      / {3,}Review task/,
      "no attention column hole before a quiet title",
    );
    assert(frame.lines.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(frame.lines[0], /latest|Σ|\$/);
  }
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
