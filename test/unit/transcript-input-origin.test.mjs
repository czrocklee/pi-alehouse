import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
  getMarkdownTheme,
  initTheme,
  SkillInvocationMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, visibleWidth } from "@earendil-works/pi-tui";

// Load the production source, not a potentially stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");
const { humanSteerLead } = await jiti.import(
  "../../src/orchestration/presentation/human-steer-text.ts",
);

// Keep the SDK's native user body on a deterministic palette even on headless runners.
setCapabilityOverrides({ trueColor: true });
test.after(() => setCapabilityOverrides({}));
initTheme("dark", false);

const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
const WIDTH = 200;

/** Every label the pane can print above a user message. */
const LABELS = [
  "From parent",
  "From user",
  "Alehouse input",
  "Input",
  "Steering input (human lead)",
];

/** Capture the real host Theme via the public tool-renderer callback. */
let hostTheme;
{
  const probe = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "probe", name: "probe_theme", arguments: {} }],
        },
      ],
      inFlight: () => undefined,
      toolDefinition: () => ({
        renderCall: (_args, theme) => {
          hostTheme = theme;
          return { render: () => ["PROBE"], invalidate() {} };
        },
      }),
    },
  });
  try {
    probe.slice(WIDTH, 0, probe.lineCount(WIDTH));
  } finally {
    probe.dispose();
  }
}

/** A pane over a fixed message list, with an optional origin lookup. */
const contentOver = (messages, inputOrigin, theme = hostTheme) =>
  new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    theme,
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
      ...(inputOrigin ? { inputOrigin } : {}),
    },
  });

// eslint-disable-next-line no-control-regex -- strip the theme's own SGR spans
const SGR = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text) => text.replace(SGR, "");

const styledRows = (content, width) => content.slice(width, 0, content.lineCount(width));

/** The pane's rows, trimmed and free of styling, so labels compare literally. */
const rowsOf = (content, width = WIDTH) =>
  styledRows(content, width).map((row) => stripAnsi(row).trim());

const paint = (content, width = WIDTH) => rowsOf(content, width).join("\n");

/** The user-message labels in painted order, which is also the assertion that
 * no other label was printed for any message. */
const labelSequence = (content, width = WIDTH) =>
  rowsOf(content, width).filter((row) => LABELS.includes(row));

const user = (text) => ({ role: "user", content: text, timestamp: 1 });

/** An origin lookup over the exact message objects, by identity. */
const origins = (map) => (message) => map.get(message);

test("each confirmed origin gets its own label, with no content inference", () => {
  const fromParent = user("PARENT_TEXT"),
    fromHuman = user("HUMAN_TEXT"),
    fromOrchestration = user("ORCHESTRATION_TEXT");
  const messages = [fromParent, fromHuman, fromOrchestration];
  const content = contentOver(
    messages,
    origins(
      new Map([
        [fromParent, "parent"],
        [fromHuman, "human"],
        [fromOrchestration, "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user", "Alehouse input"]);
    const text = paint(content);
    for (const body of ["PARENT_TEXT", "HUMAN_TEXT", "ORCHESTRATION_TEXT"])
      assert.match(text, new RegExp(body), `${body} is still shown`);
  } finally {
    content.dispose();
  }
});

test("only confirmed parent prose gets the left-aligned mdHeading card", (t) => {
  // Give mdHeading a distinct color via the host Theme callbacks, so an
  // accidental return to accent (or another stock alias) cannot pass.
  const parentFg = hostTheme.getFgAnsi("success");
  const userFg = hostTheme.getFgAnsi("userMessageText");
  const userBg = hostTheme.getBgAnsi("userMessageBg");
  assert.notEqual(parentFg, userFg);
  assert.notEqual(parentFg, hostTheme.getFgAnsi("customMessageLabel"));
  assert.notEqual(parentFg, hostTheme.getFgAnsi("accent"));
  const theme = {
    fg: (token, text) => hostTheme.fg(token === "mdHeading" ? "success" : token, text),
    bg: hostTheme.bg.bind(hostTheme),
  };
  const prose = "PARENT PROSE 你好 👩‍💻";
  const width = 60;
  const message = user(prose);
  const originCases = [
    ["confirmed parent", () => "parent", "From parent"],
    ["confirmed human", () => "human", "From user"],
    ["confirmed orchestration", () => "orchestration", "Alehouse input"],
    ["unknown", undefined, "Input"],
  ];
  const fgClose = "\x1b[39m";
  const bgClose = "\x1b[49m";
  for (const [name, origin, label] of originCases) {
    const content = contentOver([message], origin, theme);
    t.after(() => content.dispose());
    assert.deepEqual(labelSequence(content, width), [label]);
    const rows = styledRows(content, width);
    const title = rows.find((row) => stripAnsi(row).trim() === label);
    assert.ok(title && !title.includes(userBg), `${name}: label above the body background`);
    const fromParent = label === "From parent";
    const pad = fromParent ? 2 : 1;
    assert.equal(leadingSpaces(stripAnsi(title)), pad, `${name}: label inset`);
    assert.ok(
      stripAnsi(title).startsWith(`${" ".repeat(pad)}${label}`),
      `${name}: label starts on the left`,
    );
    const bgRows = rows.filter((row) => row.includes(userBg));
    assert.equal(bgRows.length, 3, `${name}: padding, body, padding`);
    const coloredWidth = fromParent ? visibleWidth(prose) + pad * 2 : width;
    for (const row of bgRows) {
      const start = row.indexOf(userBg);
      const end = row.indexOf(bgClose, start + userBg.length);
      assert.ok(end > start, `${name}: the background closes`);
      assert.equal(visibleWidth(row.slice(0, start)), 0, `${name}: no left gap`);
      assert.equal(visibleWidth(row.slice(start + userBg.length, end)), coloredWidth);
      assert.match(stripAnsi(row.slice(end + bgClose.length)), /^ *$/, `${name}: no ink beyond BG`);
      assert.ok(!row.slice(end + bgClose.length).includes(userBg), `${name}: the gap is unpainted`);
    }
    const body = bgRows[1];
    assert.equal(stripAnsi(body).trim(), prose);
    assert.equal(leadingSpaces(stripAnsi(body)), pad, `${name}: body inset matches the label`);
    const ink = fromParent ? parentFg : userFg;
    const fgStart = body.indexOf(ink);
    const fgEnd = body.indexOf(fgClose, fgStart + ink.length);
    assert.ok(fgStart >= 0 && fgEnd > fgStart, `${name}: foreground covers the prose`);
    assert.equal(stripAnsi(body.slice(fgStart + ink.length, fgEnd)).trim(), prose);
  }
});

const backgroundWidth = (row, bg) => {
  const start = row.indexOf(bg) + bg.length;
  return visibleWidth(row.slice(start, row.indexOf("\x1b[49m", start)));
};

const leadingSpaces = (row) => row.match(/^ */)?.[0].length ?? 0;

test("parent Markdown keeps native indentation without filling the width cap", (t) => {
  const width = 80;
  const pad = 2;
  const bg = hostTheme.getBgAnsi("userMessageBg");
  for (const [name, markdown, expected] of [
    ["fenced command", "```sh\nnpm run check\n```", ["  ```sh", "    npm run check", "  ```"]],
    ["nested list", "- Heading\n  - **宽字符** 👩‍💻 tail", ["  - Heading", "      - 宽字符 👩‍💻 tail"]],
  ]) {
    const content = contentOver([user(markdown)], () => "parent");
    t.after(() => content.dispose());
    const body = styledRows(content, width).filter((row) => row.includes(bg));
    assert.deepEqual(
      body.map((row) => stripAnsi(row).trimEnd()),
      ["", ...expected, ""],
      name,
    );
    const inkWidth = Math.max(...expected.map((line) => visibleWidth(line)));
    const cardWidth = inkWidth + pad;
    assert.ok(cardWidth < width, `${name}: card is narrower than the pane`);
    for (const row of body)
      assert.equal(backgroundWidth(row, bg), cardWidth, `${name}: background hugs the ink`);
  }
});

test("long confirmed parent prose wraps within the card cap while unknown input keeps its native width", (t) => {
  const width = 70;
  const cap = 63;
  const bg = hostTheme.getBgAnsi("userMessageBg");
  const message = user("repeatable words ".repeat(9).trimEnd());
  const withParent = contentOver([message], () => "parent");
  const unknown = contentOver([message]);
  t.after(() => withParent.dispose());
  t.after(() => unknown.dispose());
  const card = styledRows(withParent, width).filter((row) => row.includes(bg));
  const wide = styledRows(unknown, width).filter((row) => row.includes(bg));
  // Width 70 caps the card at 63 (tenth gutter) and full native rows stay 70.
  // Three phrases are 50 cells, so two-cell insets shrink-wrap to 54, not the cap.
  const line = "  repeatable words repeatable words repeatable words  ";
  assert.deepEqual(
    card.map((row) => stripAnsi(row)),
    [" ".repeat(54), line, line, line, " ".repeat(54)],
    "parent prose paints the shrink-wrapped tenth-gutter card",
  );
  assert.equal(Math.max(...card.map((row) => backgroundWidth(row, bg))), 54);
  for (const row of wide) assert.equal(visibleWidth(row), width);
  assert.equal(
    rowsOf(withParent, width)
      .join(" ")
      .match(/repeatable/g)?.length,
    9,
  );

  // Unlike spaced prose, a continuous run uses the whole content width and
  // distinguishes the 90% ceiling from a wider (or unconstrained) card.
  const capped = contentOver([user("x".repeat(width))], () => "parent");
  t.after(() => capped.dispose());
  const cappedRows = styledRows(capped, width).filter((row) => row.includes(bg));
  assert.equal(Math.max(...cappedRows.map((row) => backgroundWidth(row, bg))), cap);
});

test("parent label and body share responsive horizontal padding", (t) => {
  const prose = "Yo";
  const bg = hostTheme.getBgAnsi("userMessageBg");
  const content = contentOver([user(prose)], () => "parent");
  t.after(() => content.dispose());
  // One card, resized: wide inset, one-cell cap, unpadded floor, then restored.
  const cases = [
    [70, 2, visibleWidth("From parent") + 4],
    [7, 1, 5],
    [3, 0, 3],
    [70, 2, visibleWidth("From parent") + 4],
  ];
  for (const [width, pad, cardWidth] of cases) {
    const rows = styledRows(content, width);
    const bgRows = rows.filter((row) => row.includes(bg));
    const title = rows.find((row) => !row.includes(bg) && stripAnsi(row).trim());
    const body = bgRows.find((row) => stripAnsi(row).includes(prose));
    assert.ok(title && body, `rows at width ${width}`);
    assert.equal(bgRows.length, 3, `vertical padding stays at ${width}`);
    assert.equal(leadingSpaces(stripAnsi(title)), pad, `label inset at ${width}`);
    assert.equal(leadingSpaces(stripAnsi(body)), pad, `body inset at ${width}`);
    assert.equal(
      stripAnsi(body).trimEnd(),
      `${" ".repeat(pad)}${prose}`,
      `body spacing at ${width}`,
    );
    for (const row of bgRows)
      assert.equal(backgroundWidth(row, bg), cardWidth, `card width at ${width}`);
    if (width >= 8) assert.ok(cardWidth < width, `card is not the full pane at ${width}`);
  }
});

test("parent and orchestration text carrying the human lead is neither relabeled nor stripped", () => {
  const lead = `${humanSteerLead}\n\nDO_NOT_STRIP`;
  const fromParent = user(lead),
    fromOrchestration = user(lead);
  const content = contentOver(
    [fromParent, fromOrchestration],
    origins(
      new Map([
        [fromParent, "parent"],
        [fromOrchestration, "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "Alehouse input"]);
    const text = paint(content);
    assert.doesNotMatch(text, /Steering input \(human lead\)/);
    assert.equal(
      text.match(/Direct message from the human user/g)?.length,
      2,
      "the lead bytes stay for both non-human origins",
    );
    assert.equal(text.match(/DO_NOT_STRIP/g)?.length, 2);
  } finally {
    content.dispose();
  }
});

test("a confirmed human origin names the speaker and drops only the exact lead", () => {
  const steered = user(`${humanSteerLead}\n\nCHANGE_TABS_TO_SPACES`),
    plain = user("PLAIN_HUMAN_TEXT"),
    quoted = user(`reminder quoting the lead: ${humanSteerLead}`);
  const messages = [steered, plain, quoted];
  const content = contentOver(
    messages,
    origins(
      new Map([
        [steered, "human"],
        [plain, "human"],
        [quoted, "human"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From user", "From user", "From user"]);
    const text = paint(content);
    assert.match(text, /CHANGE_TABS_TO_SPACES/);
    assert.match(text, /PLAIN_HUMAN_TEXT/);
    assert.equal(
      text.match(/Direct message from the human user/g)?.length,
      1,
      "only the mid-text quotation keeps the lead bytes",
    );
    assert.doesNotMatch(text, /Steering input \(human lead\)/);
  } finally {
    content.dispose();
  }
});

test("unknown, absent, throwing and unrecognized origins keep the existing labels", () => {
  const steered = () => user(`${humanSteerLead}\n\nSTEERED_BODY`);
  const cases = [
    ["absent lookup", undefined],
    ["undefined result", () => undefined],
    [
      "throwing lookup",
      () => {
        throw new Error("origin unavailable");
      },
    ],
    ["unrecognized value", () => "system"],
  ];
  for (const [name, inputOrigin] of cases) {
    const plain = user("GENERIC_TEXT"),
      lead = steered();
    const content = contentOver([plain, lead], inputOrigin);
    try {
      assert.deepEqual(
        labelSequence(content),
        ["Input", "Steering input (human lead)"],
        `${name} keeps the neutral and lead-qualified fallbacks`,
      );
      const text = paint(content);
      assert.match(text, /GENERIC_TEXT/, `${name} still renders the generic message`);
      assert.match(text, /STEERED_BODY/, `${name} still renders the lead message`);
      assert.equal(
        text.match(/Direct message from the human user/g),
        null,
        `${name} strips the exact lead prefix, as before`,
      );
    } finally {
      content.dispose();
    }
  }
});

test("identical text with different recorded origins stays distinct by message identity", () => {
  const parentCopy = user("IDENTICAL_TEXT"),
    humanCopy = user("IDENTICAL_TEXT");
  assert.notEqual(parentCopy, humanCopy);
  const received = [];
  const content = contentOver([parentCopy, humanCopy], (message) => {
    received.push(message);
    return message === parentCopy ? "parent" : message === humanCopy ? "human" : undefined;
  });
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user"]);
    assert.deepEqual(
      received,
      [parentCopy, humanCopy],
      "the lookup is asked about the exact message objects, never their text",
    );
    assert.equal(
      paint(content).match(/IDENTICAL_TEXT/g)?.length,
      2,
      "both bodies render literally",
    );
  } finally {
    content.dispose();
  }
});

test("a compaction or branch rewrite re-reads each retained message's own origin", () => {
  let messages = [user("SAME_TEXT"), user("SAME_TEXT")];
  const first = messages[0],
    second = messages[1];
  const byObject = new Map([
    [first, "parent"],
    [second, "human"],
  ]);
  let reads = 0;
  // The source reads the live binding, so a rewrite is actually observed.
  const content = new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    theme: hostTheme,
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: () => undefined,
      inputOrigin: (message) => {
        reads++;
        return byObject.get(message);
      },
    },
  });
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user"]);
    const beforeBranch = reads;

    // Branch rewrite: the same text at the same index is now a different
    // message with a different origin. Nothing may carry over from the old one.
    const branchCopy = user("SAME_TEXT");
    byObject.set(branchCopy, "human");
    messages = [branchCopy, second];
    assert.deepEqual(labelSequence(content), ["From user", "From user"]);
    assert.ok(reads > beforeBranch, "the rewritten prefix is re-read");

    // Compaction: the prefix is replaced by a summary, and the retained user
    // message keeps its own confirmed origin rather than a neutral label.
    const postCompaction = user("POST_COMPACTION_TEXT");
    byObject.set(postCompaction, "orchestration");
    messages = [
      { role: "compactionSummary", summary: "COMPACTED_SUMMARY_TEXT", tokensBefore: 12345 },
      postCompaction,
      second,
    ];
    const compacted = paint(content);
    assert.match(compacted, /COMPACTED_SUMMARY_TEXT/);
    assert.match(compacted, /POST_COMPACTION_TEXT/);
    assert.deepEqual(labelSequence(content), ["Alehouse input", "From user"]);
    assert.doesNotMatch(compacted, /Task input/);
  } finally {
    content.dispose();
  }
});

test("origin labels rewrite no source bytes and keep skills/native bodies intact", () => {
  const skillText =
    '<skill name="review" location="/skills/review.md">\nSKILL_CONTENT\n</skill>\n\nSKILL_USER_MESSAGE';
  const messages = [
    user("PARENT_TEXT"),
    user(`${humanSteerLead}\n\nHUMAN_STEER_BODY`),
    user(skillText),
  ];
  const before = structuredClone(messages);
  const content = contentOver(
    messages,
    origins(
      new Map([
        [messages[0], "parent"],
        [messages[1], "human"],
        [messages[2], "orchestration"],
      ]),
    ),
  );
  try {
    assert.deepEqual(labelSequence(content), ["From parent", "From user", "Alehouse input"]);
    const text = paint(content);
    assert.match(text, /SKILL_CONTENT/, "a skill block still renders through the SDK component");
    assert.match(text, /SKILL_USER_MESSAGE/);
    assert.deepEqual(messages, before, "rendering rewrites no source message");
  } finally {
    content.dispose();
  }
});

test("resizing a parent skill card retains its SDK view; full and theme invalidation refresh it", (t) => {
  const skillText =
    '<skill name="review" location="/skills/review.md">\n# 宽 SKILL_CONTENT\n\n' +
    `宽字符 ${"reviewable words ".repeat(6).trimEnd()}\n</skill>\n\n宽 SKILL_USER_MESSAGE`;
  const messages = [user(skillText)];
  const origin = () => "parent";
  const content = contentOver(messages, origin);
  t.after(() => {
    content.dispose();
    initTheme("dark", false);
  });

  const prototype = SkillInvocationMessageComponent.prototype;
  const invalidations = t.mock.method(prototype, "invalidate");
  const originalRender = prototype.render;
  let skill, skillChild;
  t.mock.method(prototype, "render", function (width) {
    skill = this;
    skillChild = this.children[0];
    return originalRender.call(this, width);
  });

  const wide = styledRows(content, 80);
  const initialSkill = skill;
  const initialChild = skillChild;
  assert.ok(initialChild, "the real SDK skill view rendered");
  content.invalidateLayout();
  const narrow = styledRows(content, 40);
  assert.ok(narrow.length > wide.length, "skill content reflows at the new width");
  assert.match(narrow.map(stripAnsi).join("\n"), /SKILL_CONTENT.*SKILL_USER_MESSAGE/s);
  assert.equal(invalidations.mock.callCount(), 0, "layout skips the SDK skill invalidate override");
  assert.equal(skill, initialSkill);
  assert.equal(skillChild, initialChild, "layout does not rebuild the SDK skill view");

  const skillBg = hostTheme.getBgAnsi("customMessageBg");
  const userBg = hostTheme.getBgAnsi("userMessageBg");
  assert.notEqual(skillBg, userBg);
  // Width 70 shrink-wraps to 61 (cap is 63, pane is 70). Narrow caps are 5 and 3.
  for (const [width, pad, cardWidth] of [
    [70, 2, 61],
    [7, 1, 5],
    [3, 0, 3],
    [70, 2, 61],
  ]) {
    const rows = styledRows(content, width);
    assert.equal(skill, initialSkill, `same skill instance at ${width}`);
    assert.equal(skillChild, initialChild, `same skill view at ${width}`);
    const skillRows = rows.filter((row) => row.includes(skillBg));
    const userRows = rows.filter((row) => row.includes(userBg));
    assert.ok(
      skillRows.some((row) => !stripAnsi(row).trim()),
      `skill vertical padding stays at ${width}`,
    );
    assert.ok(
      userRows.some((row) => !stripAnsi(row).trim()),
      `user vertical padding stays at ${width}`,
    );
    for (const row of skillRows) assert.equal(backgroundWidth(row, skillBg), cardWidth);
    for (const row of userRows) assert.equal(backgroundWidth(row, userBg), cardWidth);
    const skillPlain = skillRows.map(stripAnsi);
    const userPlain = userRows.map(stripAnsi);
    const skillInk = skillPlain.map((row) => row.trim()).join("");
    const userInk = userPlain.map((row) => row.trim()).join("");
    assert.match(skillInk, /宽\s*SKILL_CONTENT/);
    assert.match(skillInk, /宽字符/);
    assert.match(userInk, /宽\s*SKILL_USER_MESSAGE/);
    assert.equal(skillInk.split("宽").length, 3, "heading and body keep both CJK clusters");
    assert.equal(userInk.split("宽").length, 2, "user prose keeps its CJK cluster");
    if (width >= 70) {
      assert.equal(
        skillPlain.find((row) => row.includes("SKILL_CONTENT")).trimEnd(),
        "  宽 SKILL_CONTENT",
      );
      assert.equal(
        skillPlain.find((row) => row.includes("宽字符")).trimEnd(),
        "  宽字符 reviewable words reviewable words reviewable words",
      );
      assert.equal(
        userPlain.find((row) => row.includes("SKILL_USER_MESSAGE")).trimEnd(),
        "  宽 SKILL_USER_MESSAGE",
      );
      assert.notEqual(cardWidth, 63);
      assert.notEqual(cardWidth, width);
    } else {
      const clusters = [...skillPlain, ...userPlain].filter((row) => /[宽字符]/.test(row));
      assert.deepEqual(
        clusters.map((row) => row.trim()),
        ["宽", "宽", "字", "符", "宽"],
        `whole CJK clusters at ${width}`,
      );
      for (const row of clusters) assert.equal(leadingSpaces(row), pad, `CJK inset at ${width}`);
    }
  }

  content.invalidate();
  assert.deepEqual(styledRows(content, 40), narrow);
  assert.equal(invalidations.mock.callCount(), 1, "full invalidation uses the SDK override");
  assert.notEqual(skillChild, initialChild, "full invalidation rebuilds the SDK skill view");

  initTheme("light", false);
  content.setTheme(getMarkdownTheme());
  const light = styledRows(content, 40);
  assert.notEqual(skill, initialSkill, "palette replacement recreates the SDK skill component");
  assert.notDeepEqual(light, narrow, "the real light palette changes the rendered ANSI");
  assert.deepEqual(light.map(stripAnsi), narrow.map(stripAnsi));
  const fresh = contentOver(messages, origin);
  t.after(() => fresh.dispose());
  assert.deepEqual(light, styledRows(fresh, 40), "palette replacement matches a fresh transcript");
  const native = contentOver(messages);
  t.after(() => native.dispose());
  const nativeHeading = styledRows(native, 70)
    .map(stripAnsi)
    .find((row) => row.includes("SKILL_CONTENT"));
  assert.equal(leadingSpaces(nativeHeading), 1, "nonparent skill keeps the SDK one-cell inset");
});

test("a short parent card adds no chrome rows and keeps its read anchor", () => {
  const labeled = user("ANCHORED_LABELED_TEXT"),
    assistant = { role: "assistant", content: [{ type: "text", text: "ACK" }], stopReason: "stop" };
  const messages = [labeled, assistant];
  const withOrigin = contentOver(messages, origins(new Map([[labeled, "parent"]])));
  const withoutOrigin = contentOver(messages);
  try {
    assert.deepEqual(
      rowsOf(withOrigin).length,
      rowsOf(withoutOrigin).length,
      "a label names the speaker without changing the block's height",
    );
    assert.deepEqual(labelSequence(withOrigin), ["From parent"]);
    assert.deepEqual(labelSequence(withoutOrigin), ["Input"]);

    const labelRow = rowsOf(withOrigin).indexOf("From parent");
    assert.ok(labelRow >= 0, "the label is its own row");
    const anchor = withOrigin.captureAnchor(WIDTH, labelRow);
    assert.notEqual(anchor, undefined, "a labeled user block is anchorable");
    assert.equal(
      withOrigin.resolveAnchor(WIDTH, anchor),
      labelRow,
      "the anchor round-trips to the same labeled block",
    );
    assert.equal(withOrigin.captureAnchor(WIDTH, -1), undefined);
    assert.equal(withOrigin.resolveAnchor(WIDTH, { kind: "block", offset: 0 }), undefined);
    assert.equal(
      withOrigin.lineCount(WIDTH),
      withoutOrigin.lineCount(WIDTH),
      "no chrome rows are added by a confirmed origin",
    );
  } finally {
    withOrigin.dispose();
    withoutOrigin.dispose();
  }
});
