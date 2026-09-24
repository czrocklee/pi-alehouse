import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DetailPane, renderDetailFields, renderDetailTitle, transcriptRule, wrapText }
  from "../../dist/ui/agent-detail.js";
import { paneRow } from "../../dist/ui/format.js";
import { renderWidget } from "../../dist/ui/agent-widget.js";
import { addToLedger } from "../../dist/core/usage-ledger.js";

const spend = (input, output, cache_read, cache_write, cost, model = "anthropic/claude-opus-5") =>
  addToLedger(undefined, { input, output, cache_read, cache_write, cost }, model);

const theme = { fg: (_color, text) => text, bold: (text) => text };
const cwd = "/workspace/project";
const view = (overrides = {}) => ({
  owner_id: "o", generation: "g", agent_id: "a-19b7", run_id: "r-8f3a", name: "reviewer",
  description: "审查 controller.ts 的生命周期合同",
  effective_settings: { provider: "anthropic", model: "claude-opus-5", thinking: "medium", parent_thinking: "medium",
    thinking_resolution: "identity", profile: "reader",
    difficulty: 5, strength: "strong", preset: "team", preset_version: "v2", selection_digest: "1".repeat(64),
    cwd, tools: ["read", "grep", "find", "ls"], definition_digest: "0".repeat(64), context_mode: "none" },
  status: "running", phase: "executing", execution_exited: false, finalization_pending: false, resumable: true,
  owner_blocked: false, notification_drops: 0, pending_messages: 0, isolation: "shared",
  elapsed_ms: 93000, turn_elapsed_ms: 1100, turns: 3, max_turns: 256, max_duration_ms: 1800000, execution_elapsed_ms: 93000,
  usage: spend(61200, 3100, 19900, 0, null),
  cleanup_errors: [], discarded_inputs: [], ...overrides,
});
const live = (overrides = {}) => ({ active_tools: [], tool_uses: 12, preview: "", ...overrides });
const body = (v = {}, l = {}, width = 90) => renderDetailFields({ view: view(v), live: live(l) }, theme, width);
const joined = (...args) => body(...args).join("\n");

test("wrapText never exceeds its budget, counting CJK by the columns it occupies", () => {
  const text = "turnStarted 在 turnEnd 里被清掉，所以两个 turn 之间 turn_elapsed_ms 会变成 undefined";
  for (const columns of [12, 20, 33, 48]) {
    const lines = wrapText(text, columns);
    for (const line of lines) assert.ok(visibleWidth(line) <= columns, `${columns}: ${JSON.stringify(line)}`);
    // Wrapping is reversible: no character is invented or dropped.
    assert.equal(lines.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  }
});

test("wrapText breaks latin at spaces and keeps every explicit newline", () => {
  assert.deepEqual(wrapText("the quick brown fox jumps", 12), ["the quick", "brown fox", "jumps"]);
  assert.deepEqual(wrapText("one\ntwo", 40), ["one", "two"]);
});

test("the title pairs the agent with its live state and fits the width", () => {
  const title = renderDetailTitle({ view: view(), live: live() }, 0, theme, 60);
  assert.match(title, /^reviewer \(reader\)/);
  // Given room the title also carries the task, which the chrome never scrolls away;
  // too narrow for a useful fragment, it is dropped rather than shown as a stub.
  assert.match(renderDetailTitle({ view: view(), live: live() }, 0, theme, 100), /\) {2}审查 controller\.ts/);
  assert.match(title, /审查/, "removing the obsolete role leaves room for the task label");
  assert.match(title, /⠋ running$/);
  assert.equal(visibleWidth(title) <= 60, true);
  assert.match(renderDetailTitle({ view: view({ status: "completed" }), live: live() }, 0, theme, 60), /✓ completed$/);
  // Our own finalization is a distinct fact from the model still streaming.
  assert.match(renderDetailTitle({ view: view({ finalization_pending: true }), live: live() }, 0, theme, 60), /finishing$/);
  // An Agent the model never named is titled by its profile, once and without empty parentheses.
  const unnamed = renderDetailTitle({ view: view({ name: "" }), live: live() }, 0, theme, 60);
  assert.match(unnamed, /^reader {2}审查/, "a capability name is not a readable one; the task is");
  assert.doesNotMatch(unnamed, /\(/);
  // The task takes only what identity and status leave, and never their room.
  for (const width of [60, 44, 30]) {
    const long = view({ name: "", description: "审查".repeat(60) });
    const tight = renderDetailTitle({ view: long, live: live() }, 0, theme, width);
    assert.equal(visibleWidth(tight), width, JSON.stringify(tight));
    assert.match(tight, /⠋ running$/, `a long task crowded out the status at ${width}: ${JSON.stringify(tight)}`);
  }
});

test("the body carries the identity, configuration and lifecycle the widget line cannot", () => {
  const text = joined();
  assert.match(text, /task\s+审查 controller\.ts 的生命周期合同/);
  assert.match(text, /run\s+r-8f3a · agent a-19b7/);
  assert.match(text, /routing\s+team@v2 · d5→strong/);
  assert.match(text, /effort\s+medium · parent identity · fixed at creation/);
  assert.doesNotMatch(text, /source:/, "older settings cannot acquire invented provenance");
  assert.match(text, /model\s+claude-opus-5/);
  assert.doesNotMatch(text, /anthropic\//);
  assert.match(text, /cwd\s+\/workspace\/project/);
  assert.match(text, /tools\s+read grep find ls/);
  assert.match(text, /phase\s+executing · resumable/);
  assert.ok(!text.includes("transcript"), "the transcript is a collaborator, not part of the field block");
});

test("detail fields preserve the model id and show context totals separately from billed tokens", () => {
  const settings = { ...view().effective_settings, provider: "openai-codex", model: "gpt-5.6-sol" };
  const context = (tokens) => joined({ effective_settings: settings,
    runtime: { activity: "generating", context: { tokens, context_window: 272000 } } });
  assert.match(context(231000), /model\s+gpt-5\.6-sol/);
  assert.doesNotMatch(context(231000), /openai-codex/);
  assert.match(context(231000), /context\s+≈231k\/272k tokens · 84\.9%/);
  assert.match(context(null), /context\s+unknown\/272k tokens · \?/);
  assert.match(context(0), /context\s+≈0\/272k tokens · 0\.0%/);
  assert.match(context(231000), /tokens\s+in 61\.2k/, "the usage ledger is a separate figure");
  assert.doesNotMatch(joined(), /context\s+/, "no snapshot is not an invented zero");
});

test("detail context and all billed-token components promote their rounded unit without touching the ledger", () => {
  for (const [value, billed, context] of [[1000, "1.0k", "1k"], [999499, "999.5k", "999k"],
    [999500, "999.5k", "1.0M"], [999949, "999.9k", "1.0M"], [999950, "1.0M", "1.0M"],
    [999999, "1.0M", "1.0M"], [1000000, "1.0M", "1.0M"]]) {
    const usage = spend(value, value, value, value, 0.0042);
    const before = structuredClone(usage);
    const lines = body({ usage, runtime: { activity: "generating", context: { tokens: value, context_window: 2000000 } } }, {}, 200);
    const tokens = lines.find(line => /^ {2}tokens\s/.test(line));
    assert.ok(tokens?.endsWith(`in ${billed} · out ${billed} · cache r ${billed} · w ${billed}`), tokens);
    assert.ok(lines.some(line => line.includes(`≈${context}/2.0M tokens`)), String(value));
    assert.ok(lines.some(line => /cost\s+\$0\.004/.test(line)));
    assert.doesNotMatch(lines.join("\n"), /1000(?:\.0)?k/);
    assert.deepEqual(usage, before, "formatting cannot round the ledger itself");
  }
});

test("detail routing shows the admitted difficulty beside its resolved slot", () => {
  for (const [difficulty, strength] of [[1, "light"], [2, "light"], [3, "standard"], [4, "strong"], [5, "strong"]]) {
    const text = joined({ effective_settings: { ...view().effective_settings, difficulty, strength } });
    assert.ok(text.includes(`team@v2 · d${difficulty}→${strength}`), text);
  }
});

test("detail effort distinguishes inherited identity, mapped override and fixed preset effort", () => {
  const settings = view().effective_settings;
  assert.match(joined({ effective_settings: { ...settings, effort_source: "preset" } }),
    /effort\s+medium · parent identity · source: preset · fixed at creation/);
  const mapped = joined({ effective_settings: { ...settings, parent_thinking: "low", thinking: "high",
    thinking_resolution: "preset_mapping", effort_source: "user_override" } });
  assert.match(mapped, /effort\s+high · low→high \(preset map\) · source: user override · fixed at creation/);
  for (const parent of [undefined, "off"]) {
    const fixed = { ...settings, thinking: "high", thinking_resolution: "preset_fixed", effort_source: "preset" };
    if (parent === undefined) delete fixed.parent_thinking;
    else fixed.parent_thinking = parent;
    const text = joined({ effective_settings: fixed });
    assert.match(text, /effort\s+high · preset fixed · source: preset · fixed at creation/);
    assert.doesNotMatch(text, /parent identity|preset map|off→high/);
  }
});

test("effort provenance wraps on narrow panes without clipping or inventing a source", () => {
  const settings = { ...view().effective_settings, thinking: "high", parent_thinking: "low",
    thinking_resolution: "preset_mapping", effort_source: "user_override" };
  for (const width of [32, 40, 62]) {
    const lines = body({ effective_settings: settings }, {}, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(lines)}`);
    const effortAt = lines.findIndex((line) => /^ {2}effort\s/.test(line));
    assert.ok(effortAt >= 0);
    const following = lines.slice(effortAt, lines.findIndex((line, i) => i > effortAt && /^ {2}model\s/.test(line)));
    assert.match(following.join(" "), /user\s+override/);
    assert.match(following.join(" "), /fixed\s+at\s+creation/);
    const oldSettings = { ...settings };
    delete oldSettings.effort_source;
    assert.doesNotMatch(body({ effective_settings: oldSettings }, {}, width).join(" "), /source:/);
  }
});

test("deadline display distinguishes unstarted Runs from zero elapsed execution", () => {
  for (const status of ["queued", "cancelled"]) {
    const text = joined({ status, phase: status === "queued" ? "queued" : "settled", execution_exited: status === "cancelled",
      max_duration_ms: 1800000, execution_elapsed_ms: undefined });
    assert.match(text, /deadline\s+not started · 30m00s execution limit/);
    assert.doesNotMatch(text, /0\.0s \/ 30m00s/);
  }
  assert.match(joined({ max_duration_ms: 1800000, execution_elapsed_ms: 0 }), /deadline\s+0\.0s \/ 30m00s execution/);
  assert.match(joined({ max_duration_ms: 1800000, execution_elapsed_ms: 1000, status: "completed", execution_exited: true }),
    /deadline\s+1\.0s \/ 30m00s execution/);
});

test("both clocks and the full usage split are spelled out", () => {
  const text = joined();
  assert.match(text, /turns\s+↻3≤256 · this turn 1\.1s · total 1m33s/);
  // The unit belongs in the label, not four times over in the value.
  assert.match(text, /tokens\s+in 61\.2k · out 3\.1k · cache r 19\.9k · w 0$/m);
  assert.match(text, /calls\s+12 uses/);
  // Missing telemetry is unknown, never an invented zero.
  assert.match(joined({ usage: undefined }), /tokens\s+not reported/);
  assert.match(text, /cost\s+not reported/);
});

/**
 * A Run is many responses. One of them arriving unpriced used to null the whole
 * Run's cost, so a real bill rendered as "not reported" -- the operator saw
 * nothing where money had actually been spent.
 */
test("a figure some response left out is shown as a floor, not as nothing", () => {
  const priced = addToLedger(spend(1000, 100, 0, 0, 2.5), { input: 500, output: 50, cache_read: 0, cache_write: 0, cost: null },
    "anthropic/claude-opus-5");
  const text = joined({ usage: priced });
  assert.match(text, /cost\s+≥ /, text);
  assert.match(text, /\$2\.5/, text);
  // Tokens every response did report carry no floor marker.
  assert.match(text, /tokens\s+in 1\.5k · out 150 /, text);
  // Nothing reported at all is still "?", which is not the same as a floor.
  const unpriced = addToLedger(undefined, { input: null, output: 10, cache_read: null, cache_write: null, cost: null },
    "anthropic/claude-opus-5");
  assert.match(joined({ usage: unpriced }), /tokens\s+in \? · out 10 · cache r \? · w \?/);
  assert.match(joined({ usage: unpriced }), /cost\s+not reported/);
});

test("every active tool is named with its argument, not just the first two", () => {
  const tools = [{ name: "read", detail: "src/core/controller.ts" }, { name: "grep", detail: '"turnStarted" in src/core' },
    { name: "ls", detail: "src/pi" }];
  const text = joined({}, { active_tools: tools });
  assert.match(text, /active\s+read src\/core\/controller\.ts/);
  assert.match(text, /grep "turnStarted" in src\/core/);
  assert.match(text, /ls src\/pi/);
  assert.match(text, /calls\s+12 uses · 3 running/);
});

test("warnings the operator must not miss are all listed, never summarised away", () => {
  const text = joined({
    outcome: { status: "needs_input", question: "用哪个分支？", limit_reached: true },
    unavailable_reason: "SESSION_UNAVAILABLE", owner_error: "flock lost", history_error: "disk full",
    pending_messages: 2, notification_drops: 1, cleanup_errors: ["child did not exit"], discarded_inputs: ["stale steer"],
  });
  for (const expected of [/asked\s+用哪个分支？/, /limit\s+stopped at the turn limit/, /session\s+SESSION_UNAVAILABLE/,
    /owner\s+flock lost/, /history\s+disk full/, /queued\s+2 message\(s\) waiting/, /dropped\s+1 notification\(s\) never reached/,
    /cleanup\s+child did not exit/, /discarded\s+stale steer/]) assert.match(text, expected);
  // A label as wide as its own column must still leave a gap before the value.
  assert.ok(!/discardedstale/.test(text));
  // `joined()` is the field block alone -- a sibling test pins that it carries
  // no transcript rule -- so there is nothing to cut off, and cutting anyway
  // would drop the last line's final character and hide a misalignment there.
  const columns = [...text.matchAll(/^ {2}(?:\S+ *)(?=\S)/gm)].map((match) => match[0].length);
  assert.equal(new Set(columns).size, 1, "every field's value starts in the same column");
});

test("every field line fits the width, counting CJK by the columns it occupies", () => {
  for (const width of [40, 62, 100]) {
    const lines = [...body({}, { active_tools: [{ name: "read", detail: "src/core/controller.ts" }],
      preview: "turnStarted 在 turnEnd 里被清掉，所以两个 turn 之间会闪" }, width),
      transcriptRule(theme, width)];
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
  }
});

test("a click on an Agent row resolves to that Agent, and chrome rows resolve to none", () => {
  const base = { turns: 3, max_turns: 256, elapsed_ms: 1, tool_uses: 0, active_tools: [], preview: "",
    question: false, limit_reached: false, pending_messages: 0, notification_drops: 0, has_run_warnings: false,
    finishing: false, name: "", profile: "editor", description: "Task" };
  const run = (id, overrides) => ({ ...base, agent_id: id, run_id: `${id}-run`, ...overrides });
  const { lines, hits } = renderWidget({
    runs: [run("q", { status: "queued" }), run("r", { status: "running" }), run("f", { status: "completed" })],
    owner: { blocked: false, resident: 2, resident_limit: 8 }, spinnerFrame: 0, width: 120, theme,
    shouldShowFinished: () => true,
  });
  assert.equal(lines.length, hits.length, "every painted line must answer who it belongs to");
  assert.equal(hits[0], undefined, "the heading belongs to no Agent");
  assert.equal(hits[1], "f");
  assert.equal(hits[2], "r", "the Agent header row");
  assert.equal(hits[3], "r", "and its ⎿ activity row, so clicking the tool line opens the Agent running it");
  assert.match(lines[3], /⎿/);
  assert.equal(hits[4], undefined, "the aggregate queued row names no single Agent");
});

test("an overflowing widget still answers correctly for the rows it did paint", () => {
  const base = { turns: 1, max_turns: 256, elapsed_ms: 1, tool_uses: 0, active_tools: [], preview: "",
    question: false, limit_reached: false, pending_messages: 0, notification_drops: 0, has_run_warnings: false,
    finishing: false, name: "", profile: "editor", description: "Task", status: "running" };
  const runs = Array.from({ length: 8 }, (_, i) => ({ ...base, agent_id: `a${i}`, run_id: `a${i}-run` }));
  const { lines, hits } = renderWidget({ runs, owner: { blocked: false, resident: 8, resident_limit: 8 },
    spinnerFrame: 0, width: 120, theme, shouldShowFinished: () => true });
  assert.equal(lines.length, hits.length);
  assert.equal(hits.at(-1), undefined, "the +N more row is a count, not an Agent");
  assert.match(lines.at(-1), /\+3 more \(3 running\)/);
  // Pairs stay paired: a header and its activity line never disagree.
  for (let i = 1; i + 1 < hits.length; i += 2) assert.equal(hits[i], hits[i + 1]);
});

// ---- The pane's scroll window across the two halves of its body ----

/** A stand-in transcript: N rows, each naming its own index. */
/** A transcript that can grow, which is the only way to tell following the
 * tail apart from merely landing on the last row of a static one. */
const fakeRows = (count) => ({
  count,
  grow(by) { this.count += by; return this; },
  lineCount() { return this.count; },
  slice(_width, start, take) {
    return Array.from({ length: Math.max(0, Math.min(take, this.count - start)) }, (_, i) => `T${start + i}`);
  },
  invalidate() {},
});
const growable = (count) => {
  const rows = fakeRows(count);
  return { rows, extra: { transcript: () => rows } };
};
const pane = (transcriptLines, rows = 20, extra = {}) => {
  const tui = { terminal: { columns: 80, rows }, requestRender: () => {} };
  const p = new DetailPane({ tui, theme, initial: "a", done: () => {},
    snapshot: () => [{ agent_id: "a", input: { view: view(), live: live() } }],
    transcript: () => fakeRows(transcriptLines), ...extra });
  return p;
};
const strip = (lines) => lines.slice(1, -1);

test("the pane paints the fields, then the rule, then the transcript, with no row lost at the seam", (t) => {
  // Tall enough that the fields, the rule and the first transcript rows are all
  // on screen at once, which is the only way to see the seam.
  const p = pane(40, 60);
  t.after(() => p.dispose());
  const fields = renderDetailFields({ view: view(), live: live() }, theme, 80);
  p.render(80);                // lay out once, so the keys have geometry
  p.handleInput("\u001b[H");    // home: pin to the top and stop following
  const top = strip(p.render(80));
  assert.equal(top[0], fields[0], "the first body row is the first field");
  assert.equal(top.filter((line) => line.includes("transcript")).length, 1, "exactly one rule");
  // The row right after the rule must be the transcript's row 0 — an off-by-one
  // here silently eats the first line of every conversation.
  const ruleAt = top.findIndex((line) => line.includes("transcript"));
  assert.equal(ruleAt, fields.length, "the rule sits directly after the last field");
  assert.equal(top[ruleAt + 1], "T0", "and the transcript starts on the very next row");
  assert.equal(top[ruleAt + 2], "T1");
});

test("the pane follows the live tail by default, as the main conversation does", (t) => {
  const { rows, extra } = growable(200);
  const p = pane(200, 20, extra);
  t.after(() => p.dispose());
  assert.equal(strip(p.render(80)).at(-1), "T199", "a freshly opened pane sits at the newest row");
  // The transcript grows under the reader; still following, so the view moves
  // with it. A pane that merely opened on the last row would stay on T199.
  rows.grow(60);
  assert.equal(strip(p.render(80)).at(-1), "T259", "following carries the view to the new tail");
});

for (const input of ["keyboard", "wheel"]) test(`an empty pane ignores ${input} scrolling against its previous geometry`, (t) => {
  let available = true;
  const { rows, extra } = growable(200);
  const p = pane(200, 20, { ...extra,
    snapshot: () => available ? [{ agent_id: "a", input: { view: view(), live: live() } }] : [] });
  t.after(() => p.dispose());
  assert.equal(strip(p.render(80)).at(-1), "T199");
  available = false;
  assert.match(p.render(80).join("\n"), /No agents/);
  if (input === "keyboard") p.handleInput("\u001b[H"); // Home must not pin an invisible body.
  else assert.equal(p.handleMouse({ type: "wheel", wheelDelta: -1 }), undefined);
  available = true; rows.grow(60);
  assert.equal(strip(p.render(80)).at(-1), "T259", "the same Agent returns without losing tail-follow intent");
});

test("scrolling up stops the follow, and reaching the end again resumes it", (t) => {
  const { rows, extra } = growable(200);
  const p = pane(200, 20, extra);
  t.after(() => p.dispose());
  p.render(80);
  p.handleInput("\u001b[A"); // up
  const held = strip(p.render(80));
  assert.equal(held.at(-1), "T198", "the view stays where the reader put it");
  assert.equal(strip(p.render(80)).at(-1), "T198", "and does not drift on the next frame");
  // Growth must not move a reader who scrolled away, however far the tail runs.
  rows.grow(60);
  assert.equal(strip(p.render(80)).at(-1), "T198", "a stopped follow stays stopped as the tail grows");
  p.handleInput("\u001b[F"); // end
  assert.equal(strip(p.render(80)).at(-1), "T259", "End goes to the tail as it is now");
  rows.grow(20);
  assert.equal(strip(p.render(80)).at(-1), "T279", "and following has resumed, not merely landed");
});

test("when the selected assistant exits, the pane adopts a row rather than drifting onto one", (t) => {
  let agents = ["a", "b", "c"], chosen;
  const tui = { terminal: { columns: 80, rows: 24 }, requestRender: () => {} };
  const p = new DetailPane({ tui, theme, initial: "b", done: () => {}, onSelect: (id) => { chosen = id; },
    snapshot: () => agents.map((agent_id) => ({ agent_id, input: { view: view(), live: live() } })),
    transcript: () => fakeRows(40) });
  t.after(() => p.dispose());
  const footer = () => p.render(80).at(-1);
  assert.match(footer(), /2\/3/, "the pane opens on the agent it was given");
  agents = ["a", "c"];
  assert.match(footer(), /1\/2/, "the vanished agent's row is gone and the first is shown");
  // Shown is not enough: the selection itself has to move, or left/right walk
  // from a row nobody is on and the host still thinks the gone agent is open.
  assert.equal(chosen, "a", "the host is told which agent the pane is actually on");
  p.handleInput("\u001b[C"); // right
  assert.equal(chosen, "c", "the neighbour is the one after the row on screen");
  assert.match(footer(), /2\/2/);
});

test("widget activation selects another assistant and toggles the selected one closed", (t) => {
  let chosen, closes = 0, renders = 0;
  const tui = { terminal: { columns: 80, rows: 24 }, requestRender: () => { renders++; } };
  const p = new DetailPane({ tui, theme, initial: "a", done: () => { closes++; },
    onSelect: (id) => { chosen = id; },
    snapshot: () => ["a", "b"].map((agent_id) => ({ agent_id, input: { view: view(), live: live() } })),
    transcript: () => fakeRows(40) });
  t.after(() => p.dispose());
  p.activate("b");
  assert.equal(chosen, "b");
  assert.equal(renders, 1);
  assert.match(p.render(80).at(-1), /2\/2/);
  p.activate("b");
  assert.equal(closes, 1, "clicking the selected row closes like Esc");
  p.activate("a");
  assert.equal(chosen, "b", "a closed pane ignores late row clicks");
  assert.equal(closes, 1);
});

/**
 * A body can shrink under a reader who scrolled away: a compaction, a resize, a
 * switch to an Agent with a shorter transcript. An offset left above the new
 * maximum reads as "already at the end", so the next key up re-engages
 * following instead of scrolling, and the reader is locked to the tail.
 */
test("a transcript that shrinks under a scrolled reader does not lock them to the tail", (t) => {
  const { rows, extra } = growable(200);
  const p = pane(200, 20, extra);
  t.after(() => p.dispose());
  p.render(80);
  p.handleInput("\u001b[A");
  p.handleInput("\u001b[A");
  assert.equal(strip(p.render(80)).at(-1), "T197", "the reader is two rows off the tail");
  rows.count = 30;
  const shrunk = strip(p.render(80));
  assert.equal(shrunk.at(-1), "T29", "the view lands inside what is left");
  // The offset came down with it, so Up still scrolls rather than snapping back.
  p.handleInput("\u001b[A");
  assert.equal(strip(p.render(80)).at(-1), "T28", "Up moves up");
  p.handleInput("\u001b[A");
  assert.equal(strip(p.render(80)).at(-1), "T27");
  // And following is genuinely off, so growth leaves the reader alone.
  rows.grow(40);
  assert.equal(strip(p.render(80)).at(-1), "T27", "a stopped follow survives the shrink");
});

test("a short body is not padded into a tall pane, and a tall one is capped", (t) => {
  const short = pane(1, 40);
  t.after(() => short.dispose());
  const tall = pane(400, 40);
  t.after(() => tall.dispose());
  // 70% of 40 rows, less the title and footer.
  assert.ok(tall.render(80).length <= Math.floor(40 * 0.7));
  assert.ok(short.render(80).length < tall.render(80).length, "content-sized, not a fixed share");
});

test("the footer counts the whole body, fields and transcript together", (t) => {
  const p = pane(40);
  t.after(() => p.dispose());
  const fields = renderDetailFields({ view: view(), live: live() }, theme, 80);
  assert.match(p.render(80).at(-1), new RegExp(`/${fields.length + 1 + 40} lines`));
  assert.match(p.render(80).at(-1), /^1\/1 agents/);
});

test("a pane row drops the terminal's turn markers but keeps hyperlinks and colour", () => {
  const A = "\u001b]133;A\u0007", B = "\u001b]133;B\u0007", C = "\u001b]133;C\u0007";
  // Pi marks conversation turns for the terminal's "jump to previous prompt".
  // A scrolling pane re-emits its rows constantly, so those marks would be lies.
  assert.equal(paneRow(`${A}hello${B}${C}`, 40), "hello");
  assert.equal(paneRow(`${A}\u001b[31mred\u001b[39m`, 40), "\u001b[31mred\u001b[39m", "colour is untouched");
  const link = "\u001b]8;;https://example.com\u0007text\u001b]8;;\u0007";
  assert.equal(paneRow(link, 40), link, "OSC 8 hyperlinks are content, not chrome");
  // The escape terminator may be ST rather than BEL.
  assert.equal(paneRow("\u001b]133;A\u001b\\keep", 40), "keep");
  assert.ok(visibleWidth(paneRow(`${A}这是一行中文${B}`, 8)) <= 8, "still clipped by display columns");
});

test("the wheel scrolls the pane itself and stops the event from reaching the page behind", (t) => {
  const p = pane(60, 24);
  t.after(() => p.dispose());
  p.render(80);
  p.handleInput("\u001b[H");              // home: top of the body, following off
  const before = strip(p.render(80));
  // A wheel event the pane does not own must pass through, or clicks and drags
  // over the pane would be swallowed instead of reaching whatever wants them.
  assert.equal(p.handleMouse({ type: "click" }), undefined);
  assert.equal(p.handleMouse({ type: "wheel" }), undefined, "a wheel with no delta moves nothing");
  assert.deepEqual(strip(p.render(80)), before);

  assert.deepEqual(p.handleMouse({ type: "wheel", wheelDelta: 4 }), { handled: true });
  const down = strip(p.render(80));
  assert.notDeepEqual(down, before);
  // Four logical lines down means the row that was fifth is now first.
  assert.equal(down[0], before[4]);
  assert.deepEqual(p.handleMouse({ type: "wheel", wheelDelta: -4 }), { handled: true });
  assert.deepEqual(strip(p.render(80)), before, "scrolling back returns the same window");
});

test("the wheel clamps at both ends and hands the live tail back at the bottom", (t) => {
  const { rows, extra } = growable(60);
  const p = pane(60, 24, extra);
  t.after(() => p.dispose());
  p.render(80);
  p.handleInput("\u001b[H");
  p.handleMouse({ type: "wheel", wheelDelta: -999 });
  const top = strip(p.render(80));
  assert.equal(top[0], renderDetailFields({ view: view(), live: live() }, theme, 80)[0]);
  // Past the end the pane pins to the tail and resumes following, exactly as End does.
  p.handleMouse({ type: "wheel", wheelDelta: 999 });
  const bottom = strip(p.render(80));
  assert.equal(bottom.at(-1), "T59");
  rows.grow(20);
  assert.equal(strip(p.render(80)).at(-1), "T79", "the wheel reaching the end resumes following, not just lands");
});

test("a wheel before the first paint has no geometry to move and is left alone", (t) => {
  const p = pane(60, 24);
  t.after(() => p.dispose());
  assert.equal(p.handleMouse({ type: "wheel", wheelDelta: 5 }), undefined);
});

test("a floating pane uses the worker-picker popover chrome", (t) => {
  const colors = [];
  const recording = { fg: (color, text) => { colors.push(color); return text; }, bold: (text) => text };
  const p = pane(4, 30, { frame: true, theme: recording });
  t.after(() => p.dispose());
  const lines = p.render(80);
  assert.match(lines[0], /^\u256d\u2500/);
  assert.match(lines.at(-1), /\u256f$/);
  assert.ok(colors.includes("borderAccent"), "outer corners are accent, not dim");
  assert.ok(colors.includes("borderMuted"), "sides match the picker");
  assert.ok(!colors.includes("border"), "the old generic border color is not used");
  for (const line of lines.slice(1, -1)) {
    assert.equal(line[0], "\u2502");
    assert.equal(line.at(-1), "\u2502");
  }
});

test("the floating pane draws a frame that costs columns but never rows", (t) => {
  const docked = pane(40, 30);
  const floating = pane(40, 30, { frame: true });
  t.after(() => { docked.dispose(); floating.dispose(); });
  const a = docked.render(80), b = floating.render(80);
  assert.equal(a.length, b.length, "a frame must not eat a row of transcript");
  for (const line of b) assert.equal(visibleWidth(line), 80, JSON.stringify(line));
  assert.match(b[0], /^.*\u256d/, "top border");
  assert.match(b.at(-1), /\u256f.*$/, "bottom border");
  // The title and the footer ride on the border rows rather than above and below it.
  assert.match(b[0], /reviewer \(reader\)/);
  assert.match(b.at(-1), /agents/);
  // Riding on the border does not open it: what the inlay does not use is rule.
  assert.doesNotMatch(b[0], / {3}/, `top border left open: ${JSON.stringify(b[0])}`);
  assert.doesNotMatch(b.at(-1), / {3}/, `bottom border left open: ${JSON.stringify(b.at(-1))}`);
  // The divider is a rule of the same row, so it reaches the frame it sits inside.
  assert.equal(visibleWidth(transcriptRule(theme, 78)), 78);
  for (const line of b.slice(1, -1)) {
    assert.match(line, /^\u2502/, "body rows are bounded left");
    assert.match(line, /\u2502$/, "body rows are bounded right");
  }
  // Docked, nothing is drawn around it: the widget above and Pi's footer bound it.
  assert(!a.some((line) => /[\u256d\u256e\u2570\u256f\u2502]/.test(line)));
});

test("an Agent with no Runs still closes its frame", (t) => {
  const p = pane(40, 30, { frame: true, snapshot: () => [] });
  t.after(() => p.dispose());
  const lines = p.render(60);
  assert.match(lines[0], /^\u256d\u2500 harness \u2500+ \u00d7 \u2500\u256e$/);
  assert.doesNotMatch(lines.at(-1), / {2}/);
});

test("Esc closes the pane; a printable key the footer never offered does not", (t) => {
  let closed = 0;
  const p = pane(4, 20, { done: () => { closed++; } });
  t.after(() => p.dispose());
  p.render(80);
  p.handleInput("q");
  assert.equal(closed, 0, "the pane holds focus, so a letter must not be a close");
  p.handleInput("\u001b");
  assert.equal(closed, 1);
});

test("a framed pane keeps CJK aligned and narrows gracefully", (t) => {
  const p = pane(20, 30, { frame: true });
  t.after(() => p.dispose());
  for (const width of [80, 61, 40, 24, 14, 12, 11]) {
    const lines = p.render(width);
    for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width}: ${JSON.stringify(line)}`);
  }
  assert.deepEqual(p.render(9), [], "too narrow to frame at all");
});

test("a floating pane closes from the × in its top edge; a docked pane has none", (t) => {
  let closed = 0;
  const p = pane(4, 30, { frame: true, done: () => { closed++; } });
  t.after(() => p.dispose());
  const lines = p.render(60);
  assert.match(lines[0], / × ─╮$/);
  assert.equal(p.handleMouse({ type: "click", button: "left", x: 50, y: 0 }), undefined, "the title is not the control");
  assert.equal(p.handleMouse({ type: "click", button: "right", x: 57, y: 0 }), undefined);
  assert.deepEqual(p.handleMouse({ type: "click", button: "left", x: 57, y: 0 }), { handled: true });
  assert.equal(closed, 1);
  p.handleMouse({ type: "click", button: "left", x: 57, y: 0 });
  assert.equal(closed, 1, "closing is once");

  const docked = pane(4, 30, { done: () => { closed++; } });
  t.after(() => docked.dispose());
  assert(!docked.render(60)[0].includes("×"));
  assert.equal(docked.handleMouse({ type: "click", button: "left", x: 57, y: 0 }), undefined);
  assert.equal(closed, 1);
});
