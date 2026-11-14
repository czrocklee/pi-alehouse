/**
 * Failure isolation for transcript tool cards, through public TranscriptContent
 * only. A bad display callback degrades to the bounded raw card; it must not
 * drop frame/lineCount/slice or adjacent history, and it must not surface an
 * unhandled rejection.
 *
 * Async callbacks are refused, not awaited. Message text stays on the HEAD
 * contract (tool name, recorded arguments and result text). No bubble chrome,
 * result-detachment, terminal-row filter, blocked-name, or execute-isolation
 * claims. Renderer-owned timers are out of scope.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const home = mkdtempSync(join(tmpdir(), "alehouse-transcript-failures-"));
const xdg = join(home, "xdg");
for (const [key, value] of [
  ["HOME", home],
  ["USERPROFILE", home],
  ["PI_CODING_AGENT_DIR", join(home, "agent")],
  ["XDG_CONFIG_HOME", join(xdg, "config")],
  ["XDG_DATA_HOME", join(xdg, "data")],
  ["XDG_STATE_HOME", join(xdg, "state")],
  ["XDG_CACHE_HOME", join(xdg, "cache")],
  ["XDG_RUNTIME_DIR", join(xdg, "runtime")],
]) {
  if (key !== "HOME" && key !== "USERPROFILE") mkdirSync(value, { recursive: true });
  process.env[key] = value;
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

const runNode = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const transcriptPath = fileURLToPath(
  new URL("../../src/orchestration/ui/transcript.ts", import.meta.url),
);

const { createJiti } = await import("jiti");
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text } = await import("@earendil-works/pi-tui");

initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import("../../src/orchestration/ui/transcript.ts");

const WIDTH = 160;
const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };

const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content) => ({
  role: "assistant",
  content,
  stopReason: "toolUse",
  timestamp: 1,
});
const result = (id, name, text, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});
const user = (text, timestamp) => ({ role: "user", content: text, timestamp });

function open(messages, lookup) {
  // A fresh object on every read is a binding change, not a settled card.
  const token = { generation: 1 };
  return new TranscriptContent({
    tui,
    cwd: "/w",
    markdownTheme: getMarkdownTheme(),
    source: {
      messages: () => messages,
      inFlight: () => undefined,
      toolDefinition: lookup,
      toolRenderersRevision: () => token,
    },
  });
}

/** One pass through the three public read APIs. A throw here is a lost frame. */
function readPane(content, width = WIDTH) {
  const count = content.lineCount(width);
  const slice = content.slice(width, 0, count);
  const frame = content.frame(width);
  const framed = frame.slice(0, frame.lineCount);
  return { count, slice, frameCount: frame.lineCount, text: framed.join("\n") };
}

function assertHistory(sample, { name, path, output }) {
  assert.ok(sample.count > 0);
  assert.equal(sample.slice.length, sample.count);
  assert.equal(sample.frameCount, sample.count);
  assert.match(sample.text, /BEFORE_HISTORY/);
  assert.match(sample.text, /AFTER_HISTORY/);
  assert.match(sample.text, new RegExp(name));
  assert.match(sample.text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  if (output) assert.match(sample.text, new RegExp(output));
}

test("renderShell self and default both fall back to bounded raw when the callback throws", (t) => {
  const messages = [
    user("BEFORE_HISTORY", 0),
    assistant([
      call("r1", "read", { path: "recorded/only.txt" }),
      call("f1", "fail_native", { path: "fail/native.txt" }),
    ]),
    user("AFTER_HISTORY", 2),
  ];
  const before = structuredClone(messages);
  const content = open(messages, (name) =>
    name === "read"
      ? {
          renderShell: "self",
          renderCall() {
            throw new Error("SELF_CALL_THROW");
          },
        }
      : {
          renderShell: "default",
          renderCall() {
            throw new Error("DEFAULT_CALL_THROW");
          },
        },
  );
  t.after(() => content.dispose());
  const sample = readPane(content);
  assertHistory(sample, { name: "read", path: "recorded/only.txt" });
  assertHistory(sample, { name: "fail_native", path: "fail/native.txt" });
  assert.doesNotMatch(sample.text, /SELF_CALL_THROW|DEFAULT_CALL_THROW/);
  assert.deepEqual(messages, before);
});

test("a throwing callback stays failed across frames, and a later result still shows raw", (t) => {
  let calls = 0;
  let results = 0;
  const messages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("f1", "fail_native", { path: "fail/native.txt" })]),
    user("AFTER_HISTORY", 2),
  ];
  const before = structuredClone(messages);
  const content = open(messages, () => ({
    renderShell: "default",
    renderCall() {
      calls += 1;
      throw new Error("STICKY_CALL");
    },
    renderResult() {
      results += 1;
      throw new Error("STICKY_RESULT");
    },
  }));
  t.after(() => content.dispose());
  content.lineCount(WIDTH);
  const initialCalls = calls;
  assert.ok(initialCalls >= 1, "the bad call callback is attempted");
  content.lineCount(WIDTH);
  content.invalidate();
  content.lineCount(WIDTH);
  content.invalidateLayout();
  content.lineCount(80);
  assert.equal(calls, initialCalls, "later frames do not retry the sticky call failure");
  assert.equal(results, 0);
  assert.deepEqual(messages, before);
  messages.push(result("f1", "fail_native", "FAIL_NATIVE_OUTPUT"));
  const withResult = structuredClone(messages);
  const sample = readPane(content);
  assertHistory(sample, {
    name: "fail_native",
    path: "fail/native.txt",
    output: "FAIL_NATIVE_OUTPUT",
  });
  assert.equal(calls, initialCalls, "applying the result does not retry the bad call");
  assert.equal(results, 0, "a sticky call failure does not attempt the original result callback");
  content.lineCount(WIDTH);
  content.lineCount(120);
  assert.equal(calls, initialCalls);
  assert.equal(results, 0, "later frames still do not attempt the abandoned result callback");
  assert.deepEqual(messages, withResult);
});

test("a throwing result callback sticks and later frames do not retry it", (t) => {
  let calls = 0;
  let results = 0;
  const messages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("f1", "fail_native", { path: "fail/native.txt" })]),
    result("f1", "fail_native", "FAIL_NATIVE_OUTPUT"),
    user("AFTER_HISTORY", 3),
  ];
  const before = structuredClone(messages);
  const content = open(messages, () => ({
    renderShell: "self",
    renderCall() {
      calls += 1;
      return new Text("CALL_OK", 0, 0);
    },
    renderResult() {
      results += 1;
      throw new Error("STICKY_RESULT");
    },
  }));
  t.after(() => content.dispose());
  const sample = readPane(content);
  assertHistory(sample, {
    name: "fail_native",
    path: "fail/native.txt",
    output: "FAIL_NATIVE_OUTPUT",
  });
  assert.ok(results >= 1, "the bad result callback is attempted");
  const resultAttempts = results;
  const callAttempts = calls;
  content.lineCount(WIDTH);
  content.invalidate();
  content.lineCount(80);
  content.invalidateLayout();
  content.lineCount(120);
  assert.equal(results, resultAttempts, "later frames do not retry the sticky result failure");
  assert.equal(calls, callAttempts, "later frames do not rebuild the settled call callback");
  assert.deepEqual(messages, before);
});

test("a component that throws on the first resize or expansion does not drop neighbors", (t) => {
  const resizeMessages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("f1", "fail_native", { path: "fail/native.txt" })]),
    result("f1", "fail_native", "FAIL_NATIVE_OUTPUT"),
    user("AFTER_HISTORY", 3),
  ];
  const resizeBefore = structuredClone(resizeMessages);
  let resizeArmed = false;
  let resizeThrew = false;
  const resize = open(resizeMessages, () => ({
    renderShell: "self",
    renderCall(_args, _theme, context) {
      return (
        context.lastComponent ?? {
          render() {
            if (resizeArmed) {
              resizeThrew = true;
              throw new Error("RESIZE_THROW");
            }
            return ["LAZY_RESIZE_OK"];
          },
          invalidate() {},
        }
      );
    },
  }));
  t.after(() => resize.dispose());
  const first = readPane(resize);
  assert.match(first.text, /LAZY_RESIZE_OK/);
  assert.match(first.text, /BEFORE_HISTORY/);
  assert.match(first.text, /AFTER_HISTORY/);
  assert.equal(resizeThrew, false, "the first width does not throw");
  resizeArmed = true;
  const resized = readPane(resize, 96);
  assert.equal(resizeThrew, true, "the first narrower frame reached the lazy render throw");
  assertHistory(resized, {
    name: "fail_native",
    path: "fail/native.txt",
    output: "FAIL_NATIVE_OUTPUT",
  });

  let armed = false;
  let expansionThrew = false;
  const expandMessages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("r1", "read", { path: "recorded/only.txt" })]),
    result("r1", "read", "RECORDED_OUTPUT"),
    user("AFTER_HISTORY", 3),
  ];
  const expandBefore = structuredClone(expandMessages);
  const expand = open(expandMessages, () => ({
    renderShell: "default",
    renderResult(_received, _options, _theme, context) {
      return (
        context.lastComponent ?? {
          render() {
            if (armed) {
              expansionThrew = true;
              throw new Error("EXPANSION_THROW");
            }
            return ["LAZY_EXPAND_OK"];
          },
          invalidate() {},
        }
      );
    },
  }));
  t.after(() => expand.dispose());
  const collapsed = readPane(expand);
  assert.match(collapsed.text, /LAZY_EXPAND_OK/);
  assert.match(collapsed.text, /BEFORE_HISTORY/);
  assert.match(collapsed.text, /AFTER_HISTORY/);
  armed = true;
  assert.doesNotThrow(() => expand.setToolsExpanded(true));
  const expanded = readPane(expand);
  assert.equal(expansionThrew, true, "the first expanded frame reached the lazy render throw");
  assertHistory(expanded, { name: "read", path: "recorded/only.txt", output: "RECORDED_OUTPUT" });
  assert.deepEqual(resizeMessages, resizeBefore);
  assert.deepEqual(expandMessages, expandBefore);
});

function throwingInvalidatePane(t) {
  const messages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("s1", "read", { path: "recorded/only.txt" })]),
    assistant([call("f1", "fail_native", { path: "fail/native.txt" })]),
    user("AFTER_HISTORY", 3),
  ];
  const before = structuredClone(messages);
  let throws = 0;
  const content = open(messages, (name) =>
    name === "read"
      ? { renderCall: () => new Text("SIBLING_CARD", 0, 0) }
      : {
          renderShell: "self",
          renderCall: () => ({
            render() {
              return ["BOOM_CARD"];
            },
            invalidate() {
              throws += 1;
              throw new Error("INVALIDATE_THROW");
            },
          }),
        },
  );
  t.after(() => content.dispose());
  const first = readPane(content);
  assert.match(first.text, /SIBLING_CARD/);
  assert.match(first.text, /BOOM_CARD/);
  return { content, messages, before, throws: () => throws };
}

for (const [label, drive] of [
  ["invalidate", (content) => content.invalidate()],
  ["invalidateLayout", (content) => content.invalidateLayout()],
])
  test(`${label} throw does not drop frame, slice, or neighbors`, (t) => {
    const pane = throwingInvalidatePane(t);
    const beforeDrive = pane.throws();
    assert.doesNotThrow(() => drive(pane.content));
    assert.ok(pane.throws() > beforeDrive, `${label} reached the throwing component`);
    const sample = readPane(pane.content);
    assertHistory(sample, { name: "fail_native", path: "fail/native.txt" });
    assert.match(sample.text, /SIBLING_CARD/);
    assert.match(sample.text, /BEFORE_HISTORY/);
    assert.match(sample.text, /AFTER_HISTORY/);
    assert.deepEqual(pane.messages, pane.before);
  });

test("a callback that returns a non-component degrades to raw without losing neighbors", (t) => {
  for (const shape of [null, 7, "nope", { nope: true }]) {
    const messages = [
      user("BEFORE_HISTORY", 0),
      assistant([call("f1", "fail_native", { path: "fail/native.txt" })]),
      user("AFTER_HISTORY", 2),
    ];
    const before = structuredClone(messages);
    const content = open(messages, () => ({ renderCall: () => shape }));
    t.after(() => content.dispose());
    const sample = readPane(content);
    assertHistory(sample, { name: "fail_native", path: "fail/native.txt" });
    assert.deepEqual(messages, before);
  }
});

test(
  "async call/result callbacks and async component methods degrade to raw with no unhandled rejection",
  { timeout: 30000 },
  async () => {
    const script = `import { createJiti } from "jiti";
const unhandled = [];
process.on("unhandledRejection", (reason) => { unhandled.push(String(reason)); });
const { getMarkdownTheme, initTheme } = await import("@earendil-works/pi-coding-agent");
const { Text, Container, Box } = await import("@earendil-works/pi-tui");
initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptContent } = await jiti.import(process.env.ALEHOUSE_TRANSCRIPT);
const WIDTH = 160;
const token = { generation: 1 };
const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content) => ({ role: "assistant", content, stopReason: "toolUse", timestamp: 1 });
const result = (id, name, text) => ({
  role: "toolResult", toolCallId: id, toolName: name,
  content: [{ type: "text", text }], isError: false,
});
function sample(name, path, renderers, output, invalidate = false) {
  const messages = [
    user("BEFORE_HISTORY", 0),
    assistant([call("id", name, { path })]),
    ...(output ? [result("id", name, output)] : []),
    user("AFTER_HISTORY", 3),
  ];
  const before = JSON.stringify(messages);
  let threw = false;
  let text = "";
  try {
    const content = new TranscriptContent({
      tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
      cwd: "/w",
      markdownTheme: getMarkdownTheme(),
      source: {
        messages: () => messages,
        inFlight: () => undefined,
        toolDefinition: () => renderers,
        toolRenderersRevision: () => token,
      },
    });
    content.lineCount(WIDTH);
    if (invalidate) content.invalidate();
    const count = content.lineCount(WIDTH);
    const slice = content.slice(WIDTH, 0, count);
    const frame = content.frame(WIDTH);
    text = frame.slice(0, frame.lineCount).join("\\n");
    if (slice.length !== count || frame.lineCount !== count) threw = "length";
    content.dispose();
  } catch (error) {
    threw = String(error && error.message ? error.message : error);
  }
  return {
    threw,
    intact: JSON.stringify(messages) === before,
    hasUser: text.includes("BEFORE_HISTORY") && text.includes("AFTER_HISTORY"),
    hasName: text.includes(name),
    hasPath: text.includes(path),
    hasOutput: output ? text.includes(output) : true,
    hasMarker: text.includes("ASYNC_MARKER"),
  };
}
const marker = () => new Text("ASYNC_MARKER", 0, 0);
const cases = {
  callAsyncResolve: sample("read", "recorded/only.txt", { renderCall: async () => marker() }),
  callAsyncReject: sample("read", "recorded/only.txt", {
    renderCall: async () => { throw new Error("ASYNC_CALL_REJECT"); },
  }),
  callPromiseResolve: sample("read", "recorded/only.txt", { renderCall: () => Promise.resolve(marker()) }),
  callPromiseReject: sample("read", "recorded/only.txt", {
    renderCall: () => Promise.reject(new Error("CALL_PROMISE_REJECT")),
  }),
  resultAsyncResolve: sample("fail_native", "fail/native.txt", {
    renderCall: () => new Text("fail_native fail/native.txt", 0, 0),
    renderResult: async () => marker(),
  }, "FAIL_NATIVE_OUTPUT"),
  resultAsyncReject: sample("fail_native", "fail/native.txt", {
    renderCall: () => new Text("fail_native fail/native.txt", 0, 0),
    renderResult: async () => { throw new Error("ASYNC_RESULT_REJECT"); },
  }, "FAIL_NATIVE_OUTPUT"),
  resultPromiseResolve: sample("fail_native", "fail/native.txt", {
    renderCall: () => new Text("fail_native fail/native.txt", 0, 0),
    renderResult: () => Promise.resolve(marker()),
  }, "FAIL_NATIVE_OUTPUT"),
  resultPromiseReject: sample("fail_native", "fail/native.txt", {
    renderCall: () => new Text("fail_native fail/native.txt", 0, 0),
    renderResult: () => Promise.reject(new Error("RESULT_PROMISE_REJECT")),
  }, "FAIL_NATIVE_OUTPUT"),
  renderReturnsRejection: sample("fail_native", "fail/native.txt", {
    renderShell: "self",
    renderCall: () => ({
      render() { return Promise.reject(new Error("ASYNC_RENDER")); },
      invalidate() {},
    }),
  }),
  invalidateReturnsRejection: sample("read", "recorded/only.txt", {
    renderShell: "default",
    renderCall: () => ({
      render() { return ["read recorded/only.txt"]; },
      invalidate() { return Promise.reject(new Error("ASYNC_INVALIDATE")); },
    }),
  }),
};
for (const Kind of [Container, Box]) {
  for (const method of ["render", "invalidate"]) {
    const tree = new Kind();
    tree.addChild({
      render() {
        return method === "render" ? Promise.reject(new Error("NESTED_RENDER")) : ["ASYNC_MARKER"];
      },
      invalidate() {
        if (method === "invalidate") return Promise.reject(new Error("NESTED_INVALIDATE"));
      },
    });
    const children = tree.children;
    const child = children[0];
    cases[Kind.name + method] = sample("nested", "nested/recorded.txt", {
      renderCall: () => tree,
    }, undefined, method === "invalidate");
    if (tree.children !== children || tree.children[0] !== child) throw new Error("Child identities changed");
    const leaf = {
      render() { return method === "render" ? Promise.reject(new Error("GROWING_RENDER")) : ["ASYNC_MARKER"]; },
      invalidate() { if (method === "invalidate") return Promise.reject(new Error("GROWING_INVALIDATE")); },
    };
    class Growing extends Kind {
      grown = false;
      render(width) {
        if (method === "render" && !this.grown) {
          this.grown = true;
          this.addChild(leaf);
        }
        return super.render(width);
      }
      invalidate() {
        if (method === "invalidate" && !this.grown) {
          this.grown = true;
          this.children = [leaf];
        }
        return super.invalidate();
      }
    }
    const growing = new Growing();
    cases[Kind.name + method + "Growing"] = sample("nested", "nested/growing.txt", {
      renderCall: () => growing,
    }, undefined, method === "invalidate");
    if (growing.children[0] !== leaf) throw new Error("Added child identity changed");
  }
}
const invalidateCase = new TranscriptContent({
  tui: { requestRender() {}, terminal: { columns: 80, rows: 24 } },
  cwd: "/w",
  markdownTheme: getMarkdownTheme(),
  source: {
    messages: () => [
      user("BEFORE_HISTORY", 0),
      assistant([call("r1", "read", { path: "recorded/only.txt" })]),
      user("AFTER_HISTORY", 2),
    ],
    inFlight: () => undefined,
    toolDefinition: () => ({
      renderCall: () => ({
        render() { return ["SYNC_RENDER"]; },
        invalidate() { return Promise.reject(new Error("ASYNC_INVALIDATE_PANE")); },
      }),
    }),
    toolRenderersRevision: () => token,
  },
});
let invalidateThrew = false;
let invalidateText = "";
try {
  invalidateCase.lineCount(WIDTH);
  invalidateCase.invalidate();
  invalidateCase.invalidateLayout();
  const count = invalidateCase.lineCount(WIDTH);
  invalidateText = invalidateCase.slice(WIDTH, 0, count).join("\\n");
} catch (error) {
  invalidateThrew = String(error && error.message ? error.message : error);
}
invalidateCase.dispose();
await new Promise((resolve) => setTimeout(resolve, 150));
const report = {
  unhandled,
  cases,
  invalidateThrew,
  invalidateHasBefore: invalidateText.includes("BEFORE_HISTORY"),
  invalidateHasAfter: invalidateText.includes("AFTER_HISTORY"),
};
console.log(JSON.stringify(report));
const failed = unhandled.length || invalidateThrew || Object.values(cases).some((entry) =>
  entry.threw || !entry.intact || !entry.hasUser || !entry.hasName || !entry.hasPath || !entry.hasOutput || entry.hasMarker);
if (failed) process.exitCode = 1;
`;
    const { stdout, stderr } = await runNode(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: repoRoot,
        env: { ...process.env, ALEHOUSE_TRANSCRIPT: transcriptPath },
        timeout: 20000,
        encoding: "utf8",
      },
    );
    assert.equal(stderr, "", "the isolated probe must not write errors");
    const report = JSON.parse(stdout);
    assert.deepEqual(report.unhandled, [], "async refusal leaves no unhandled rejection");
    assert.equal(
      report.invalidateThrew,
      false,
      "async invalidate rejection does not escape the pane",
    );
    assert.equal(report.invalidateHasBefore, true, "async invalidate keeps the preceding history");
    assert.equal(report.invalidateHasAfter, true, "async invalidate keeps the following history");
    for (const [name, entry] of Object.entries(report.cases)) {
      assert.equal(entry.threw, false, `${name} does not throw out of frame/lineCount/slice`);
      assert.equal(entry.intact, true, `${name} leaves the record unchanged`);
      assert.equal(entry.hasUser, true, `${name} keeps adjacent history`);
      assert.equal(entry.hasName, true, `${name} keeps the tool name`);
      assert.equal(entry.hasPath, true, `${name} keeps the recorded path`);
      assert.equal(entry.hasOutput, true, `${name} keeps a recorded result when one exists`);
      assert.equal(entry.hasMarker, false, `${name} does not paint an awaited async component`);
    }
  },
);
