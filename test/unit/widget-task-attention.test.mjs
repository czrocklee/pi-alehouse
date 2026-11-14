import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Isolate every SDK/source import from host settings, credentials and caches.
const home = mkdtempSync("/tmp/alehouse-task-attention-");
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ...["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
    `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
    join(home, "xdg", kind.toLowerCase()),
  ]),
  ...["TMPDIR", "TMP", "TEMP"].map((key) => [key, join(home, "tmp")]),
]) {
  mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const { createJiti } = await import("jiti");
const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");

// Direct current-source probe: Jiti with fsCache disabled, never a dist import,
// so a stale build can neither prove nor refute the merged attention contract.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { renderWidget } = await jiti.import("../../src/orchestration/ui/widget-render.ts");

const plain = { fg: (_color, text) => text, bold: (text) => text };
const CODE = { error: 31, warning: 33, dim: 90, muted: 35, text: 36, accent: 34, success: 32 };
const styled = {
  fg: (color, text) => `\x1b[${CODE[color] ?? 37}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};
// Inspect emitted ANSI spans, not calls made while measuring discarded layouts.
const spans = (text) =>
  text.split("\x1b[").flatMap((part) => {
    const match = /^(\d+)m(.*)$/s.exec(part);
    return match && Number(match[1]) !== 0 ? [[Number(match[1]), match[2]]] : [];
  });
const rawHeader = (result, id) => result.lines[result.hits.indexOf(id)];
const assertWholeGroups = (text) => {
  assert.equal((text.match(/\(/g) ?? []).length, (text.match(/\)/g) ?? []).length, text);
  assert.doesNotMatch(text, /\([^)]*$|\(\s*\)|\([^)]*…|\([^)]*\(/, text);
  for (const group of text.match(/\([^)]*\)/g) ?? [])
    assert.match(
      group,
      /^\((?:turn limit reached|limit|(?:run warning|warn|!)(?: · | )2(?: pending|pend)(?: · | )failed|2(?: pending|pend))\)$/,
      `only whole facts or a whole limit may survive: ${text}`,
    );
  assert.doesNotMatch(
    text.replace(/\([^)]*\)/g, ""),
    /pending|pend|failed|warning|warn|limit|[()!]/,
    text,
  );
};
const assertReadableTitle = (text, prefix) => {
  const start = found(text, prefix);
  const suffix = text.indexOf(" (", start);
  assert(suffix > start, text);
  const title = text.slice(start, suffix).trim();
  assert(
    visibleWidth(title.replace(/…/g, "")) >= 4,
    `ellipsis is not a literal title cell: ${text}`,
  );
};

const run = (id, overrides = {}) => ({
  agent_id: id,
  run_id: `${id}-run`,
  resident: true,
  status: "completed",
  name: "otter",
  profile: "editor",
  difficulty: 3,
  model: "m",
  effort: "high",
  description: "Review task",
  turns: 3,
  max_turns: 256,
  elapsed_ms: 12_400,
  active_tools: [],
  preview: "",
  pending_messages: 0,
  has_run_warnings: false,
  limit_reached: false,
  question: false,
  finishing: false,
  ...overrides,
});
const owner = (resident) => ({ blocked: false, resident, resident_limit: 12 });
const frame = (runs, options = {}) =>
  renderWidget({
    runs,
    owner: owner(runs.length),
    spinnerFrame: 0,
    width: 160,
    maxLines: 13,
    theme: plain,
    shouldShowFinished: () => true,
    ...options,
  });
const header = (result, id) => stripTerminalSequences(result.lines[result.hits.indexOf(id)]);
const end = (line, token) => visibleWidth(line.slice(0, line.indexOf(token) + token.length));
const found = (line, token) => {
  const index = line.indexOf(token);
  assert(index >= 0, `${token}: ${line}`);
  return index;
};

test("each single attention fact merges into the trailing task field as one parenthetical", () => {
  for (const [overrides, expected] of [
    [{ pending_messages: 1 }, "Review task (1 pending)"],
    [{ pending_messages: 2 }, "Review task (2 pending)"],
    [{ has_run_warnings: true }, "Review task (run warning)"],
    [{ status: "needs_input", question: true }, "Review task (needs answer)"],
    [{ status: "needs_input" }, "Review task (needs input)"],
    [{ status: "failed", error: "SDK broke" }, "Review task (failed: SDK broke)"],
    [{ status: "cancelling" }, "Review task (cancelling)"],
    [{ status: "cancelled" }, "Review task (cancelled)"],
    [{ status: "running", finishing: true }, "Review task (finishing)"],
  ]) {
    const row = run("fact", overrides),
      before = structuredClone(row);
    for (const width of [120, 160, 240]) {
      const result = frame([row], { width });
      const line = header(result, "fact");
      assert(line.endsWith(expected), `${width}: ${line}`);
      assert.doesNotMatch(line, /pendings\b/, "the count is the fact, never a plural suffix");
      assert.doesNotMatch(line, /\(\s*\)/, "no empty parenthetical is invented");
      // Attention never precedes the identity, allocation or ordinary metrics.
      assert(found(line, "otter") < found(line, "("), line);
      if (line.includes("m/high"))
        assert(found(line, "m/high") + "m/high".length <= line.indexOf("("), line);
      if (line.includes("12.4s"))
        assert(end(line, "12.4s") <= visibleWidth(line.slice(0, line.indexOf("("))), line);
      assert.equal(result.hits[result.hits.indexOf("fact")], "fact");
      assert(result.lines.every((text) => visibleWidth(text) <= width));
    }
    assert.deepEqual(row, before, "painting attention never acknowledges or rewrites the Run");
  }
});

test("queued attention paints its state in the merged field on explicit inspection pages", () => {
  const row = run("queued", { status: "queued" }),
    before = structuredClone(row);
  const result = frame([row], { expanded: true, width: 160 });
  const line = header(result, "queued");
  assert(line.endsWith("Review task (queued)"), line);
  assert(result.hits.includes("queued"));
  assert(result.lines.every((text) => visibleWidth(text) <= 160));
  assert.deepEqual(row, before);
});

test("multi-fact attention keeps the recorded severity order inside one parenthetical", () => {
  for (const [overrides, expected] of [
    [
      { status: "failed", error: "SDK broke", has_run_warnings: true, pending_messages: 2 },
      "Review task (run warning · 2 pending · failed: SDK broke)",
    ],
    [
      { status: "needs_input", question: true, has_run_warnings: true, pending_messages: 1 },
      "Review task (run warning · 1 pending · needs answer)",
    ],
    [{ status: "cancelling", has_run_warnings: true, pending_messages: 12 }, null],
  ]) {
    const row = run("multi", overrides);
    for (const width of [120, 160, 240]) {
      const line = header(frame([row], { width }), "multi");
      const warning = found(line, "run warning");
      const pendingText = line.match(/(\d+) pending/);
      assert(pendingText, `${width}: ${line}`);
      assert(warning < line.indexOf(pendingText[0]), `${width}: ${line}`);
      if (expected) assert(line.endsWith(expected), `${width}: ${line}`);
      else assert.match(line, /run warning · 12 pending · cancelling\)$/);
      assert.doesNotMatch(line, /pendings\b/, line);
    }
  }
});

test("a reached limit keeps its own final group after merged attention, without inventing a stop", () => {
  for (const [overrides, expected] of [
    [{ limit_reached: true }, "Review task (turn limit reached)"],
    [{ limit_reached: true, pending_messages: 1 }, "Review task (1 pending) (turn limit reached)"],
    [
      {
        limit_reached: true,
        status: "failed",
        error: "SDK broke",
        has_run_warnings: true,
        pending_messages: 2,
      },
      "Review task (run warning · 2 pending · failed: SDK broke) (turn limit reached)",
    ],
  ]) {
    const row = run("limited", overrides),
      before = structuredClone(row);
    for (const width of [120, 160, 240]) {
      const result = frame([row], { width, theme: styled });
      const line = header(result, "limited");
      assert(line.endsWith(expected), `${width}: ${line}`);
      assert.equal((line.match(/turn limit reached/g) ?? []).length, 1, line);
      assert.doesNotMatch(line, /\(\s*\)/, "a quiet attention group leaves no empty parens");
      assert.doesNotMatch(
        line,
        /stopped|cancelled|failed: turn/,
        "a soft limit is not a stop proof",
      );
      assert(result.lines.every((text) => visibleWidth(text) <= width));
    }
    assert.deepEqual(row, before);
  }
  // A soft limit on a completed Run keeps its success glyph, only tinted.
  const result = frame([run("soft", { limit_reached: true })], { width: 240, theme: styled });
  const painted = spans(rawHeader(result, "soft"));
  assert.deepEqual(
    painted.filter(([, text]) => text.trim() === "✓"),
    [[33, "✓"]],
  );
  assert.deepEqual(painted.at(-1), [33, "(turn limit reached)"]);
});

test("attention keeps its own colors inside the merged field, never the title tint", () => {
  const result = frame(
    [
      run("loud", {
        status: "failed",
        error: "SDK broke",
        has_run_warnings: true,
        pending_messages: 2,
        limit_reached: true,
      }),
    ],
    { width: 240, theme: styled },
  );
  const painted = spans(rawHeader(result, "loud"));
  const titleAt = painted.findIndex(([, text]) => text === "Review task");
  assert(titleAt >= 0, rawHeader(result, "loud"));
  assert.deepEqual(
    painted.slice(titleAt),
    [
      [35, "Review task"],
      [90, "("],
      [31, "run warning"],
      [90, " · "],
      [33, "2 pending"],
      [90, " · "],
      [31, "failed: SDK broke"],
      [90, ")"],
      [33, "(turn limit reached)"],
    ],
    "title, punctuation and each severity stay ordered and independently styled in the actual row",
  );
  assert.deepEqual(
    painted.filter(([, text]) => text.trim() === "✗"),
    [[31, "✗"]],
  );
  const asked = frame([run("asked", { status: "needs_input", question: true })], {
    width: 160,
    theme: styled,
  });
  assert.deepEqual(spans(rawHeader(asked, "asked")).slice(-4), [
    [35, "Review task"],
    [90, "("],
    [33, "needs answer"],
    [90, ")"],
  ]);
  assert(header(asked, "asked").endsWith("Review task (needs answer)"));
});

test("quiet roster rows keep the shared task anchor without an attention column hole", () => {
  const rows = [
    run("calm", { name: "calm", cost: 0.27 }),
    run("news", { name: "news", pending_messages: 2 }),
    run("loud", { name: "loud", has_run_warnings: true }),
  ];
  for (const width of [83, 120, 160, 240]) {
    const result = frame(rows, { width });
    const lines = rows.map((row) => header(result, row.agent_id));
    const quiet = lines[0];
    assert(quiet.endsWith("Review task"), `${width}: ${quiet}`);
    assert(lines[1].endsWith("Review task (2 pending)"), `${width}: ${lines[1]}`);
    assert(lines[2].endsWith("Review task (run warning)"), `${width}: ${lines[2]}`);
    for (const line of lines) assert.doesNotMatch(line, /\(\s*\)/, line);
    // No padded attention column: the quiet row's gap to its title is the
    // ordinary separator, never blank reserve for a sibling's warning.
    assert.doesNotMatch(quiet, / {3,}Review task/, `${width}: ${quiet}`);
    const baseline = frame(
      rows.map((row) => ({ ...row, pending_messages: 0, has_run_warnings: false })),
      { width },
    );
    const oldQuiet = header(baseline, "calm");
    for (const token of ["worker/d3", "m/high", "↻3/256", "$0.27", "12.4s"])
      assert.equal(end(quiet, token), end(oldQuiet, token), `${width}: ${token}`);
    if (!lines.some((line) => line.includes("(worker/d3)"))) {
      const starts = new Set(
        lines.map((line) => visibleWidth(line.slice(0, line.indexOf("Review task")))),
      );
      assert.equal(starts.size, 1, `${width}: grid task anchors are shared`);
      assert.match(quiet, /12\.4s {2}Review task/, `${width}: ${quiet}`);
      assert.match(lines[1], /12\.4s {2}Review task \(2 pending\)/, `${width}: ${lines[1]}`);
    }
    assert(result.lines.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(result.hits.filter(Boolean).sort(), ["calm", "loud", "news"]);
  }
});

test("the failure cause stays bounded and outranks optional model and ordinary metrics", () => {
  const cause = "x".repeat(500);
  const bounded = frame(
    [
      run("bounded", {
        status: "failed",
        error: cause,
        has_run_warnings: true,
        pending_messages: 2,
      }),
    ],
    { width: 240 },
  );
  const line = header(bounded, "bounded");
  assert.match(line, /Review task \(run warning · 2 pending · failed: x+…\)$/);
  assert.doesNotMatch(line, /x{60}/, "the detail group keeps its 60-cell ceiling");
  assert.equal((line.match(/…\)/g) ?? []).length, 1, line);

  const wrapped = "Error: SESSION_UNAVAILABLE (sdk_error): Error: SDK broke";
  const row = run("wrapped", {
    status: "failed",
    error: wrapped,
    model: "controlled",
    effort: "off",
    description: "Check diagnostics",
  });
  const before = structuredClone(row);
  const result = frame([row], { width: 120 });
  const text = header(result, "wrapped");
  assert(text.includes(`failed: ${wrapped}`), text);
  assert.match(text, /Check diagno\w*…? \(failed: /, text);
  assert.doesNotMatch(text, /controlled\/off/, "the identifying cause outranks the model label");
  assert(result.lines.every((each) => visibleWidth(each) <= 120));
  assert.equal(row.error, wrapped, "display allocation never changes the retained diagnostic");
  assert.deepEqual(row, before);
});

test("narrow 40/56-column rows use an explicit identity/tag/facts budget matrix", async (t) => {
  for (const [status, extra, state] of [
    ["failed", { error: "SDK broke" }, /\bfailed\b/],
    ["needs_input", { question: true }, /\bneeds answer\b|\banswer\?/],
    ["cancelling", {}, /\b(?:cancelling|cancel)\b/],
    ["running", { finishing: true }, /\b(?:finishing|finish)\b/],
  ]) {
    // Minimal cancel/finish/failed attention: (! 1pend cancel) = 16 cells;
    // answer? needs 17. Icon+space=2, otter=5, tag=12, task gap=2.
    // Include the 3-cell tree prefix: 3+2+5+12+2+16=40 exactly.
    // No title fits. answer? needs 17, so shortening otter to ott… (4)
    // preserves the whole tag: 3+2+4+12+2+17=40. Optional title stays absent.
    // With limit, even name=3 costs 3+2+3+12+2+16+1+7=46 >40;
    // the tag must yield, leaving full otter plus complete facts/limit.
    for (const [width, limited] of [
      [40, false],
      [56, false],
      [40, true],
      [56, true],
    ]) {
      await t.test(
        `${status}/${extra.finishing ? "finishing" : "ordinary"}/${width}/limit=${limited}`,
        () => {
          const keepTag = width === 56 || !limited;
          const expectedName =
            width === 40 && !limited && status === "needs_input" ? "ott…" : "otter";
          const row = run("narrow", {
            status,
            ...extra,
            name: "otter",
            has_run_warnings: true,
            pending_messages: 1,
            limit_reached: limited,
          });
          const before = structuredClone(row);
          const result = frame([row], { width, theme: styled });
          const text = header(result, "narrow");
          assert(text.includes(`${expectedName} `), `${status}/${width}/${limited}: ${text}`);
          const nameAt = found(text, expectedName);
          assert.equal(
            text.includes("(worker/d3)"),
            keepTag,
            `${status}/${width}/${limited}: ${text}`,
          );
          assert.doesNotMatch(text, /\(worker[^)]*…|\botte…/, text);
          const titleTint = status === "running" || status === "cancelling" ? 36 : 35;
          const titles = spans(rawHeader(result, "narrow")).filter(
            ([code, painted]) => code === titleTint && painted !== expectedName,
          );
          for (const [, painted] of titles)
            assert(
              visibleWidth(painted.replace(/…/g, "")) >= 4,
              `optional title must not steal wantedName for fewer than four literal cells: ${text}`,
            );
          const warning = text.search(/run warning|warn|!/);
          const pending = text.search(/1 pending|1pend/);
          assert(warning >= 0 && pending > warning, `${width}: ${text}`);
          assert.match(text, state);
          assert(pending < text.search(state), `${width}: ${text}`);
          // Attention trails the identity instead of the old prefixed column.
          assert(warning > nameAt, `${width}: ${text}`);
          if (limited) {
            assert.match(text, /\((?:turn limit reached|limit)\)$/, `${width}: ${text}`);
            assert(text.search(state) < text.search(/\((?:turn limit reached|limit\))$/), text);
          } else assert.doesNotMatch(text, /\((?:turn limit reached|limit)\)/, text);
          if (width === 40 && !limited && keepTag) {
            assert.doesNotMatch(
              text.slice(nameAt + expectedName.length),
              /Rev|…/,
              `title must not steal protected identity/tag/facts: ${text}`,
            );
            if (status === "needs_input")
              assert.match(text, /ott… \(worker\/d3\) {2}\(! 1pend answer\?\)$/, text);
            if (status === "cancelling") assert.match(text, /\(! 1pend cancel\)$/, text);
            if (extra.finishing) assert.match(text, /\(! 1pend finish\)$/, text);
          }
          assert.equal(result.hits[1], "narrow");
          assert(result.lines.every((line) => visibleWidth(line) <= width));
          assert.deepEqual(row, before);
        },
      );
    }
  }
});

test("tiny 8–24 column viewports degrade boundedly and keep the painted identity hit", async (t) => {
  for (const width of [8, 12, 20, 24]) {
    await t.test(`whole groups at ${width}`, () => {
      const result = frame(
        [
          run("tiny", {
            status: "failed",
            error: "SDK broke",
            pending_messages: 2,
            has_run_warnings: true,
            limit_reached: true,
          }),
        ],
        { width, theme: styled },
      );
      assert(
        result.lines.every((line) => visibleWidth(line) <= width),
        `${width}: ${result.lines}`,
      );
      assert.equal(result.hits[1], "tiny");
      const text = header(result, "tiny");
      assertWholeGroups(text);
      assert.doesNotMatch(text, /(?:2\s*pen(?:d(?:ing)?)?|turn limit reache?)…/, text);
    });
  }
  // Complete pending-only groups fit: 3 tree + 2 icon + 5 name + 2 gap
  // + 7 '(2pend)' [+ 1 + 7 '(limit)'] = 19 [27], below 20 [30].
  for (const [width, limited] of [
    [20, false],
    [30, true],
  ]) {
    await t.test(`complete pending at ${width}/limit=${limited}`, () => {
      const result = frame([run("count", { pending_messages: 2, limit_reached: limited })], {
        width,
      });
      const text = header(result, "count");
      assert.match(text, /\botter\b/, text);
      assert.match(text, /\(2(?: pending|pend)\)/, text);
      assertWholeGroups(text);
      if (limited) assert.match(text, /\(limit\)$/, text);
      else assert.doesNotMatch(text, /limit/, text);
      assert.equal(result.hits[1], "count");
      assert(result.lines.every((line) => visibleWidth(line) <= width));
    });
  }
});

test("CJK, emoji, ANSI, empty and long titles keep cell-accurate clipping with merged attention", () => {
  for (const [description, title] of [
    ["复核路径规范化及 lint 修复".repeat(12), "复"],
    ["👩‍💻🦉 é Review ".repeat(20), "👩‍💻"],
    ["\x1b[31mReview ANSI title\x1b[0m ".repeat(20), "Re"],
    ["", undefined],
    [" \n\t ", undefined],
  ]) {
    const row = run("text", {
      description,
      pending_messages: 1,
      limit_reached: true,
      has_run_warnings: true,
    });
    const before = structuredClone(row);
    for (const width of [40, 56, 83, 120, 160, 240]) {
      for (const th of [plain, styled]) {
        const result = frame([row], { width, theme: th });
        const text = header(result, "text");
        assert.match(text, /1 pending|1pend/, `${width}: ${text}`);
        assert.doesNotMatch(text, /\(\s*\)/, `${width}: ${text}`);
        if (width === 40) {
          // Full otter would cost 41, but nickname shortens before tag yields:
          // tree 3 + icon 2 + ott… 4 + tag 12 + gap 2 + facts 9 + limit 8
          // = 40. Keep that identity/tag/facts combination, omit every title.
          assert.match(text, /ott… \(worker\/d3\) {2}\(! 1pend\) \(limit\)$/, text);
          assert.doesNotMatch(
            text.replace("ott…", ""),
            /复|👩|Review|\bRe|…/,
            `optional title cannot displace the protected tag: ${text}`,
          );
        } else {
          assert.match(text, /\botter\b/, `${width}: ${text}`);
          if (title) assertReadableTitle(text, title);
          else assert.doesNotMatch(text, /…/, `blank titles invent no text: ${text}`);
        }
        if (width >= 120)
          assert.match(
            text,
            /\(run warning · 1 pending\) \(turn limit reached\)$/,
            `${width}: ${text}`,
          );
        assert(
          result.lines.every((line) => visibleWidth(line) <= width),
          `${width}: ${result.lines}`,
        );
        assert.equal(result.hits[1], "text");
      }
    }
    assert.deepEqual(row, before);
    // With cancelling rather than limit, tree+otter+tag+compact facts use
    // all 40 cells. Every title, including CJK/emoji, must be wholly absent.
    const protectedRow = run("protected", {
      description,
      status: "cancelling",
      pending_messages: 1,
      has_run_warnings: true,
    });
    const protectedBefore = structuredClone(protectedRow);
    const protectedFrame = frame([protectedRow], { width: 40, theme: styled });
    const protectedText = header(protectedFrame, "protected");
    assert.match(protectedText, /otter \(worker\/d3\) {2}\(! 1pend cancel\)$/, protectedText);
    assert.doesNotMatch(protectedText, /复|👩|Review|\bRe|…/, protectedText);
    assert.equal(protectedFrame.hits[1], "protected");
    assert(protectedFrame.lines.every((line) => visibleWidth(line) <= 40));
    assert.deepEqual(protectedRow, protectedBefore);
  }
  // A quiet empty title paints no separator and no parenthetical at all.
  for (const description of ["", " \n\t "]) {
    const line = header(frame([run("quiet", { description })]), "quiet");
    assert.doesNotMatch(line, /→/, line);
    assert.doesNotMatch(line, /\(/, line);
  }
});

test("long titles yield to the merged facts, which stay last", () => {
  const row = run("long", {
    status: "running",
    description: "Review controller lifecycle and pending input ".repeat(10),
    pending_messages: 3,
    has_run_warnings: true,
  });
  for (const width of [80, 120, 160, 240]) {
    const result = frame([row], { width });
    const text = header(result, "long");
    assert.match(text, /run warning|warn|!/, `${width}: ${text}`);
    assert.match(text, /3 pending|3pend/, `${width}: ${text}`);
    assert(text.indexOf("run warning") < text.indexOf("3 pending"), `${width}: ${text}`);
    assert.match(text, /Review.*… \(/, `${width}: ${text}`);
    assertReadableTitle(text, "Review");
    assert.match(text, /\botter\b/, text);
    assert.match(text, /worker\/d3/, text);
    assert(result.lines.every((line) => visibleWidth(line) <= width));
  }
});

test("pagination keeps roster-wide task anchors, header clocks and mouse hits with merged attention", () => {
  const rows = Array.from({ length: 8 }, (_, index) =>
    run(`live${index}`, {
      status: "running",
      name: `live${index}`,
      turn_elapsed_ms: 61_000,
      pending_messages: index % 2,
      has_run_warnings: index % 3 === 0,
      limit_reached: index % 4 === 0,
    }),
  );
  for (const maxLines of [3, 6, 13]) {
    const width = maxLines === 3 ? 80 : 160;
    const options = { width, maxLines, expanded: true, theme: styled };
    const starts = new Set();
    for (let page = 0, pages = 1; page < pages; page++) {
      const result = frame(rows, { ...options, page });
      const baseline = frame(
        rows.map((row) => ({
          ...row,
          pending_messages: 0,
          has_run_warnings: false,
          limit_reached: false,
        })),
        { ...options, page },
      );
      pages = result.pagination?.pages ?? 1;
      assert.deepEqual(result.hits, baseline.hits, `${maxLines}/${page}: hits`);
      assert.deepEqual(result.pagination, baseline.pagination, `${maxLines}/${page}: pages`);
      for (const [index, line] of result.lines.entries()) {
        const text = stripTerminalSequences(line);
        if (text.includes("⎿")) assert.equal(line, baseline.lines[index]);
        const id = result.hits[index];
        if (!id || text.includes("⎿")) continue;
        if (maxLines === 3) {
          assert(text.includes("1m01s"), `${maxLines}/${page}: ${text}`);
          assert.equal(
            text.includes("1m01s"),
            stripTerminalSequences(baseline.lines[index]).includes("1m01s"),
            "the fallback clock is unchanged by merged attention",
          );
        }
        const source = rows.find((row) => row.agent_id === id);
        if (source.limit_reached) assert.match(text, /\((?:turn limit reached|limit)\)$/);
        if (source.pending_messages) assert.match(text, /1 pending|1pend/);
      }
      if (maxLines === 6)
        for (const id of result.hits.filter(Boolean)) {
          const text = stripTerminalSequences(result.lines[result.hits.indexOf(id)]);
          if (text.includes("Review task"))
            starts.add(visibleWidth(text.slice(0, text.indexOf("Review task"))));
        }
    }
    if (maxLines === 6) assert.equal(starts.size, 1, "task anchors are page-independent");
  }
});

test("right-aligned metric cells keep their shared column under merged attention", () => {
  const rows = [
    run("cheap", { name: "cheap", cost: 0.27 }),
    run("pricey", { name: "pricey", cost: 12.3, pending_messages: 1 }),
  ];
  for (const width of [120, 160]) {
    const result = frame(rows, { width });
    const lines = rows.map((row) => header(result, row.agent_id));
    assert.equal(end(lines[0], "$0.27"), end(lines[1], "$12.30"), `${width}: ${lines.join("\n")}`);
    assert.equal(end(lines[0], "12.4s"), end(lines[1], "12.4s"), `${width}: ${lines.join("\n")}`);
    assert(lines[1].endsWith("Review task (1 pending)"), `${width}: ${lines[1]}`);
    assert(result.lines.every((line) => visibleWidth(line) <= width));
  }
});

test("painting is pure: repeated frames are identical and never touch runs or owner", () => {
  const rows = [
    run("a", { pending_messages: 2, has_run_warnings: true }),
    run("b", { status: "failed", error: "SDK broke", limit_reached: true }),
    run("c", { status: "needs_input", question: true }),
  ];
  const snapshot = structuredClone(rows),
    state = owner(3),
    stateSnapshot = structuredClone(state);
  const first = frame(rows, { owner: state, width: 160 });
  const second = frame(rows, { owner: state, width: 160 });
  assert.deepEqual(first, second, "a pure projection has no paint-local drift");
  assert.deepEqual(rows, snapshot, "painting never acknowledges or rewrites observed Runs");
  assert.deepEqual(state, stateSnapshot, "painting never reads back or modifies Owner state");
});
