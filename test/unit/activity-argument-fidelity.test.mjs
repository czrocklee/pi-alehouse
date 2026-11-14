import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

// Exercise the shared source, never a possibly stale dist build.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { identifyingToolArgs } = await jiti.import(
  "../../src/orchestration/presentation/tool-identity.ts",
);
const { singleLineToolArgumentDisplay } = await jiti.import(
  "../../src/orchestration/presentation/tool-argument-text.ts",
);
const { renderActivity } = await jiti.import("../../src/orchestration/ui/format.ts");
const { renderDetailFields } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);

const theme = { fg: (_color, text) => text, bold: (text) => text };
const cwd = "/fixture/project";
const activePrefix = "  active    ";
const detailInput = (active_tools, directory = cwd) => ({
  view: {
    owner_id: "o",
    generation: "g",
    agent_id: "a",
    run_id: "r",
    name: "worker",
    description: "Inspect argument fidelity",
    effective_settings: {
      provider: "fixture",
      model: "fixture-model",
      thinking: "medium",
      parent_thinking: "medium",
      thinking_resolution: "identity",
      profile: "editor",
      difficulty: 3,
      strength: "d3",
      preset: "fixture",
      preset_version: "v1",
      selection_digest: "1".repeat(64),
      cwd: directory,
      tools: ["read", "edit", "write", "ls", "bash"],
      definition_digest: "0".repeat(64),
      context_mode: "none",
    },
    status: "running",
    phase: "executing",
    execution_exited: false,
    finalization_pending: false,
    resumable: true,
    owner_blocked: false,
    pending_messages: 0,
    elapsed_ms: 1000,
    turns: 1,
    max_turns: 8,
    cleanup_errors: [],
    discarded_inputs: [],
  },
  live: { active_tools, tool_uses: active_tools.length, preview: "" },
});

function assertSurfaces(name, args, expected, verb, directory = cwd) {
  const original = structuredClone(args);
  const detail = identifyingToolArgs(name, args, directory);
  assert.equal(detail, expected, "the raw argument is encoded once at observation ingress");
  const input = detailInput([{ name, detail }], directory);
  const before = structuredClone(input);
  const widget = renderActivity(input.live.active_tools, input.live, theme, 200);
  const fields = renderDetailFields(input, theme, 200);
  const active = fields.filter((line) => line.startsWith(activePrefix));
  assert.equal(widget, `${verb} ${expected}`, "widget retains the encoded argument verbatim");
  assert.deepEqual(
    active,
    [`${activePrefix}${name} ${expected}`],
    "Info retains the same argument",
  );
  for (const row of [widget, ...fields]) {
    assert.doesNotMatch(row, /[\p{Cc}\p{Bidi_Control}]/u);
    assert(visibleWidth(row) <= 200);
  }
  assert.deepEqual(args, original, "display does not modify the raw tool arguments");
  assert.deepEqual(input, before, "both renderers are read-only projections");
  return { widget, active: active[0] };
}

for (const [name, verb] of [
  ["read", "reading"],
  ["edit", "editing"],
  ["write", "writing"],
  ["ls", "listing"],
])
  test(`${name} backslash and tab path identities survive widget and Info without double escaping`, () => {
    const rendered = [
      ["dir\\name/file.ts", "dir\\\\name/file.ts"],
      ["dir/\tfile.ts", "dir/\\x09file.ts"],
      ["dir/\\x09file.ts", "dir/\\\\x09file.ts"],
    ].map(([raw, expected]) => assertSurfaces(name, { path: `${cwd}/${raw}` }, expected, verb));
    assert.equal(new Set(rendered.map(({ widget }) => widget)).size, 3);
    assert.equal(new Set(rendered.map(({ active }) => active)).size, 3);
  });

test("encoded absolute paths retain their identity while Info removes the literal cwd prefix", () => {
  const directory = "/fixture/dir\\name\troot";
  const path = `${directory}/file\\name.ts`;
  // Passing no cwd at ingress leaves the encoded absolute path for Info to shorten.
  const detail = identifyingToolArgs("read", { path }, "");
  assert.equal(detail, "/fixture/dir\\\\name\\x09root/file\\\\name.ts");
  const input = detailInput([{ name: "read", detail }], directory);
  assert.equal(
    renderActivity(input.live.active_tools, input.live, theme, 200),
    `reading ${detail}`,
  );
  assert(renderDetailFields(input, theme, 200).includes(`${activePrefix}read file\\\\name.ts`));
});

test("commands preserve repeated spaces, NBSP, U3000 and edge whitespace on both surfaces", () => {
  const command = "  echo   a\u00a0\u3000b  ";
  assertSurfaces("bash", { command }, command, "running");
});

for (const [kind, command, expected] of [
  ["malformed CSI", "echo safe\x1b[actualcommand tail", "echo safe\\x1b[actualcommand tail"],
  ["unfinished CSI", "echo safe\x1b[123;", "echo safe\\x1b[123;"],
  ["OSC BEL", "echo safe\x1b]0;actualcommand\x07 tail", "echo safe\\x1b]0;actualcommand\\x07 tail"],
  ["unfinished OSC", "echo safe\x1b]0;actualcommand tail", "echo safe\\x1b]0;actualcommand tail"],
  [
    "OSC ST",
    "echo safe\x1b]0;actualcommand\x1b\\ tail",
    "echo safe\\x1b]0;actualcommand\\x1b\\\\ tail",
  ],
])
  test(`${kind} command payload survives ingress, widget and Info with no raw ESC`, () => {
    assertSurfaces("bash", { command }, expected, "running");
  });

test("already-encoded display guard is idempotent and preserves whitespace and escape distinctions", () => {
  const samples = [
    "  echo   a\u00a0\u3000b  ",
    "dir\\\\name/\\x09file.ts",
    "dir/\\\\x09file.ts",
    "echo safe\\x1b]0;payload\\x07 tail",
    "echo \\n not a newline",
    "👩‍💻 می‌روم ♥️ e\u0301",
  ];
  for (const text of samples) {
    assert.equal(singleLineToolArgumentDisplay(text), text);
    assert.equal(singleLineToolArgumentDisplay(singleLineToolArgumentDisplay(text)), text);
  }
});

test("already-encoded display guard visibly neutralizes remaining raw controls without stripping payloads", () => {
  for (const cp of [...Array(0xa0).keys()].filter((cp) => cp < 0x20 || cp >= 0x7f)) {
    const expected = cp === 0x0a ? "\\n" : `\\x${cp.toString(16).padStart(2, "0")}`;
    const output = singleLineToolArgumentDisplay(`before${String.fromCodePoint(cp)}after`);
    assert.equal(output, `before${expected}after`);
    assert.equal(singleLineToolArgumentDisplay(output), output);
    assert.doesNotMatch(output, /\p{Cc}/u);
  }
  for (const cp of [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ]) {
    const output = singleLineToolArgumentDisplay(`a${String.fromCodePoint(cp)}b`);
    assert.equal(output, `a\\u${cp.toString(16).padStart(4, "0")}b`);
    assert.equal(singleLineToolArgumentDisplay(output), output);
    assert.doesNotMatch(output, /\p{Bidi_Control}/u);
  }
  const raw = "\\x09 literal\t actual\x1b]0;payload\x07\n tail";
  const expected = "\\x09 literal\\x09 actual\\x1b]0;payload\\x07\\n tail";
  assert.equal(singleLineToolArgumentDisplay(raw), expected);
  const input = detailInput([{ name: "bash", detail: raw }]);
  assert.equal(
    renderActivity(input.live.active_tools, input.live, theme, 200),
    `running ${expected}`,
  );
  assert(renderDetailFields(input, theme, 200).includes(`${activePrefix}bash ${expected}`));
});
