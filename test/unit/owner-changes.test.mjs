import assert from "node:assert/strict";
import test from "node:test";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Exercise source without touching shared build output or session storage.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { ChildActivity, ChildActivityRegistry } = await jiti.import(
  "../../src/orchestration/runtime/activity-observer.ts",
);
const { OwnerChangeMonitor } = await jiti.import(
  "../../src/orchestration/runtime/owner-changes.ts",
);

const start = (path, toolCallId = "call", toolName = "edit") => ({
  type: "tool_execution_start",
  toolName,
  toolCallId,
  args: { path, command: "git clone source checkout", content: "raw input not retained" },
});
const result = (path, toolCallId = "call", toolName = "edit", overrides = {}) => ({
  type: "tool_result",
  toolName,
  toolCallId,
  input: { path, edits: [{ oldText: "private file text", newText: "private replacement" }] },
  isError: false,
  ...overrides,
  get content() {
    throw new Error("Changes must not inspect result content");
  },
});
const end = (toolCallId = "call", toolName = "edit", overrides = {}) => ({
  type: "tool_execution_end",
  toolName,
  toolCallId,
  isError: false,
  durationMs: 0,
  get result() {
    throw new Error("Changes must not inspect the result payload");
  },
  ...overrides,
});
const rejectBeforeExecution = (toolCallId, toolName = "edit") => ({
  type: "tool_execution_end",
  toolName,
  toolCallId,
  isError: true,
});
const attempt = (agentId, agentLabel, tool, outcome) => ({ agentId, agentLabel, tool, outcome });
const groupFor = (snapshot, path) => snapshot.groups.find((group) => group.path === path);
const withoutPatches = ({ groups, truncated }) => ({
  groups: groups.map(({ path, reports }) => ({
    path,
    attempts: reports.map(({ attempt }) => attempt),
  })),
  truncated,
});

function events(activity) {
  const listeners = new Map();
  activity.extension({ on: (name, handler) => listeners.set(name, handler) });
  return (event, ctx) => {
    assert.equal(listeners.get(event.type)?.(event, ctx), undefined, "observation is inert");
  };
}

function complete(observe, path, id = "call", tool = "edit") {
  observe(start(path, id, tool));
  observe(result(path, id, tool));
  observe(end(id, tool));
}

test("owner Changes is disabled by default and clear disables it for a replacement registry binding", () => {
  const registry = new ChildActivityRegistry();
  const initial = registry.getOwnerChangeCounts();
  const checkDisabled = (activity) => {
    const names = [];
    activity.extension({ on: (name) => names.push(name) });
    assert(!names.includes("tool_result"), "headless observation registers no detail handler");
    assert.equal(activity.workspaceMonitor, undefined);
    assert.equal(activity.begin(), undefined, "disabled observation has no Run cleanup");
    complete(events(activity), "skipped.txt");
    assert.strictEqual(registry.getOwnerChangeCounts(), initial);
    assert.deepEqual(registry.listOwnerChanges(), {
      groups: [],
      truncated: false,
      workspaceHints: 0,
    });
  };
  checkDisabled(registry.track("headless", "/project"));
  registry.enableOwnerChanges();
  const activity = registry.track("human", "/project");
  const done = activity.begin();
  complete(events(activity), "shown.txt");
  done();
  assert.equal(registry.getOwnerChangeCounts().paths, 1);
  registry.clear();
  checkDisabled(registry.track("replacement", "/project"));
});

test("interactive activity installs observers only for admitted edit/write or Bash tools", () => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  for (const [tools, changes, workspace] of [
    [["read", "grep"], false, false],
    [["write"], true, false],
    [["bash"], false, true],
    [["edit", "bash"], true, true],
  ]) {
    const activity = registry.track(tools.join("+"), "/project", "synthetic", tools);
    const hooks = new Set();
    activity.extension({ on: (hook) => hooks.add(hook) });
    assert.equal(hooks.has("tool_result"), changes);
    assert.equal(!!activity.workspaceMonitor, workspace);
    const done = activity.begin();
    assert.equal(typeof done === "function", changes);
    done?.();
  }
});

test("only edit and write events reach the Changes Run; stale cleanup cannot close a new one", () => {
  const seen = [],
    cleared = [];
  let run = 0;
  const activity = new ChildActivity("/project", () => {
    const token = ++run;
    return {
      observe: ({ toolName }) => seen.push([token, toolName]),
      clear: () => cleared.push(token),
    };
  });
  const emit = events(activity);
  const old = activity.begin();
  complete(emit, "unused", "read", "read");
  complete(emit, "unused", "edit", "edit");
  const fresh = activity.begin();
  old();
  complete(emit, "unused", "bash", "bash");
  complete(emit, "unused", "write", "write");
  fresh();
  fresh();
  assert.deepEqual(seen, [...Array(3).fill([1, "edit"]), ...Array(3).fill([2, "write"])]);
  assert.deepEqual(cleared, [1, 2]);
});

test("groups real edit/write targets across children independently of roster and Run lifetime", () => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const a = registry.track("id-a", "/admitted/project", "alpha");
  const b = registry.track("id-b", "/admitted/project/src", "beta");
  const aEmit = events(a),
    bEmit = events(b);
  const aDone = a.begin(),
    bDone = b.begin();
  // Provider call IDs can repeat across child sessions. Bash cwd/clone hints
  // are deliberately outside this projection.
  aEmit(start("checkout", "shell", "bash"));
  aEmit(end("shell", "bash"));
  aEmit(start("@./src/./hello.md"));
  bEmit(start("/admitted/project/src/hello.md", "call", "write"));
  bEmit(result("hello.md", "call", "write"));
  bEmit(end("call", "write", { durationMs: undefined, isError: true }));
  aEmit(result("src/hello.md"));
  aEmit(end());
  aDone();
  bDone();
  const aResumed = a.begin();
  complete(aEmit, "./src/hello.md");
  aResumed();
  registry.retain(new Set());
  assert.equal(registry.observations.get("id-a"), undefined);
  assert.equal(registry.observations.get("id-b"), undefined);
  assert.deepEqual(withoutPatches(registry.listOwnerChanges()), {
    groups: [
      {
        path: "/admitted/project/src/hello.md",
        attempts: [
          attempt("id-b", "beta", "write", "failed"),
          attempt("id-a", "alpha", "edit", "reported-success"),
          attempt("id-a", "alpha", "edit", "reported-success"),
        ],
      },
    ],
    truncated: false,
  });
  assert.deepEqual(Object.keys(a.snapshot()).sort(), ["active_tools", "preview", "tool_uses"]);
});

test("observes post-validation targets and only attests matched SDK-reported outcomes", () => {
  const monitor = new OwnerChangeMonitor();
  const run = monitor.bind("id", "alpha", "/project")();
  run.observe(start("pre-hook.txt", "coerced"));
  const prior = monitor.snapshot();
  assert.deepEqual(prior.groups, [
    {
      path: "/project/pre-hook.txt",
      reports: [{ attempt: attempt("id", "alpha", "edit", "unknown") }],
      net: { kind: "unavailable", reason: "incomplete" },
    },
  ]);
  run.observe(result("./actual\u00a0name.txt", "coerced"));
  run.observe(end("coerced"));

  run.observe(start("./denied.txt", "denied", "write"));
  run.observe(end("denied", "write", { durationMs: undefined, isError: true }));
  run.observe(start("untimed.txt", "untimed"));
  run.observe(result("untimed.txt", "untimed"));
  run.observe(end("untimed", "edit", { durationMs: undefined }));
  run.observe(start(false, "validation-coercion"));
  assert.equal(monitor.snapshot().truncated, true, "pathless pending calls are not shown");
  run.observe(result("false", "validation-coercion"));
  assert.equal(monitor.snapshot().truncated, false, "the effective target recovered coverage");
  run.observe(end("validation-coercion"));
  run.clear();
  const snapshot = monitor.snapshot();
  assert.deepEqual(withoutPatches(snapshot), {
    groups: [
      { path: "/project/false", attempts: [attempt("id", "alpha", "edit", "reported-success")] },
      { path: "/project/untimed.txt", attempts: [attempt("id", "alpha", "edit", "unknown")] },
      { path: "/project/denied.txt", attempts: [attempt("id", "alpha", "write", "failed")] },
      {
        path: "/project/actual name.txt",
        attempts: [attempt("id", "alpha", "edit", "reported-success")],
      },
    ],
    truncated: false,
  });
  assert.strictEqual(monitor.snapshot(), snapshot);
  assert.equal(prior.groups[0].path, "/project/pre-hook.txt");
  assert.equal(prior.groups[0].reports[0].attempt.outcome, "unknown");
  const group = snapshot.groups[0];
  for (const value of [
    snapshot,
    snapshot.groups,
    group,
    group.reports,
    group.reports[0],
    group.reports[0].attempt,
    group.net,
  ])
    assert(Object.isFrozen(value));
});

test("pending, duplicate, and stale call observations cannot create reported success", () => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const activity = registry.track("id", "/project");
  const emit = events(activity);
  const first = activity.begin();
  emit(start("lost.txt", "lost"));
  emit(result("lost.txt", "lost"));
  emit(start("first.txt", "duplicate"));
  emit(start("second.txt", "duplicate"));
  emit(result("first.txt", "duplicate"));
  emit(end("duplicate"));
  first();
  const snapshot = registry.listOwnerChanges();
  assert.deepEqual(withoutPatches(snapshot), {
    groups: [
      { path: "/project/first.txt", attempts: [attempt("id", "id", "edit", "unknown")] },
      { path: "/project/lost.txt", attempts: [attempt("id", "id", "edit", "unknown")] },
    ],
    truncated: true,
  });
  assert(snapshot.groups.every(({ net }) => net.kind === "unavailable"));
  const next = activity.begin();
  emit(end("lost"));
  emit(start("next.txt", "next", "write"));
  registry.clear();
  emit(result("next.txt", "next", "write"));
  emit(end("next", "write"));
  complete(emit, "stale.txt", "new-id");
  next();
  // Human Reset cannot reopen a sealed binding, even for a new Run.
  registry.resetChanges(registry.listOwnerChanges());
  const stale = activity.begin();
  complete(emit, "stale.txt");
  stale();
  assert.deepEqual(registry.listOwnerChanges(), {
    groups: [],
    truncated: false,
    workspaceHints: 0,
  });

  registry.enableOwnerChanges();
  const fresh = registry.track("id", "/new-project", "new");
  const freshDone = fresh.begin();
  complete(events(fresh), "fresh.txt");
  freshDone();
  assert.deepEqual(withoutPatches(registry.listOwnerChanges()), {
    groups: [
      {
        path: "/new-project/fresh.txt",
        attempts: [attempt("id", "new", "edit", "reported-success")],
      },
    ],
    truncated: false,
  });
});

test("fences a reused ID even after completion and lets a later Run reuse it cleanly", () => {
  const monitor = new OwnerChangeMonitor();
  const watch = monitor.bind("id", "alpha", "/project");
  const run = watch();
  complete(run.observe, "original.txt", "reused");
  assert.equal(monitor.snapshot().groups[0].reports[0].attempt.outcome, "reported-success");
  run.observe(start("new.txt", "reused", "write"));
  run.observe(result("late.txt", "reused"));
  run.observe(end("reused"));
  run.observe(result("new.txt", "reused", "write"));
  run.observe(end("reused", "write"));
  complete(run.observe, "triple.txt", "reused");
  run.clear();
  assert.deepEqual(monitor.snapshot(), {
    groups: [
      {
        path: "/project/original.txt",
        reports: [{ attempt: attempt("id", "alpha", "edit", "unknown") }],
        net: { kind: "unavailable", reason: "ambiguous" },
      },
    ],
    truncated: true,
  });
  const next = watch();
  complete(next.observe, "later-run.txt", "reused");
  next.clear();
  assert.deepEqual(withoutPatches(monitor.snapshot()).groups[0], {
    path: "/project/later-run.txt",
    attempts: [attempt("id", "alpha", "edit", "reported-success")],
  });
});

test("fences IDs whose result or end arrived before an observed start", () => {
  const monitor = new OwnerChangeMonitor();
  const run = monitor.bind("id", "alpha", "/project")();
  run.observe(end("end-first"));
  complete(run.observe, "unknown-end.txt", "end-first");
  run.observe(result("unknown-first.txt", "result-first"));
  complete(run.observe, "unknown-result.txt", "result-first");
  run.clear();
  assert.deepEqual(monitor.snapshot(), { groups: [], truncated: true });
});

test("bounds completed IDs per Run and fences new starts while finishing tracked attempts", () => {
  const monitor = new OwnerChangeMonitor();
  const run = monitor.bind("id", "alpha", "/project")();
  for (let i = 0; i < 255; i++) complete(run.observe, `path-${i}`, `id-${i}`);
  run.observe(start("last-tracked", "tracked"));
  run.observe(start("omitted-by-id-limit", "overflow"));
  assert.equal(monitor.snapshot().truncated, true);
  run.observe(result("last-tracked", "tracked"));
  run.observe(end("tracked"));
  complete(run.observe, "fenced", "overflow");
  run.observe(start("duplicate", "id-0"));
  run.clear();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.groups.length, 256);
  assert.equal(snapshot.groups[0].path, "/project/last-tracked");
  assert.equal(snapshot.groups[0].reports[0].attempt.outcome, "reported-success");
  assert.equal(snapshot.groups.at(-1).reports[0].attempt.outcome, "unknown");
});

test("bounds pending and retained attempts and marks omitted observations without clipping paths", () => {
  const monitor = new OwnerChangeMonitor();
  const watch = monitor.bind("id", "alpha", "/project");
  const pending = watch();
  for (let i = 0; i < 32; i++) pending.observe(start(`pending-${i}`, `id-${i}`));
  pending.observe(start("omitted-by-pending-limit", "overflow"));
  pending.observe(result("pending-0", "id-0"));
  pending.observe(end("id-0"));
  complete(pending.observe, "ambiguous-reuse", "overflow");
  pending.clear();
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.groups.length, 32);
  assert.equal(snapshot.groups.at(-1).reports[0].attempt.outcome, "reported-success");
  assert.equal(snapshot.groups[0].reports[0].attempt.outcome, "unknown");
  assert.equal(snapshot.truncated, true);

  for (let first = 0; first < 513; first += 256) {
    const run = watch();
    for (let i = first; i < Math.min(513, first + 256); i++) {
      complete(run.observe, `path-${i}`, `id-${i}`);
    }
    run.clear();
  }
  snapshot = monitor.snapshot();
  assert.equal(snapshot.groups.length, 512);
  assert.equal(snapshot.groups[0].path, "/project/path-512");
  assert.equal(snapshot.groups.at(-1).path, "/project/path-1");

  const fresh = new OwnerChangeMonitor();
  const invalid = fresh.bind("id", "alpha", "/project")();
  const unrepresentable = ["x".repeat(1025), "control\x1b", "file:///tmp/not-a-target"];
  for (const [i, path] of unrepresentable.entries()) complete(invalid.observe, path, `id-${i}`);
  invalid.clear();
  assert.deepEqual(fresh.snapshot(), { groups: [], truncated: true });
});

const patchDetails = (path, hunks) => ({
  patch: `--- ${path}\n+++ ${path}\n${hunks}`,
  diff: "Display diff is not a source of evidence",
});
const latestPatch = (snapshot, path) =>
  groupFor(snapshot, path)?.reports.findLast(({ patch }) => patch)?.patch;

function completeEdit(observe, path, details, id = "edit", finalDetails = details) {
  observe(start(path, id));
  observe(result(path, id, "edit", { details }));
  observe(end(id, "edit", { result: { details: finalDetails } }));
}

test("real pinned SDK edit projection uses normalized reported rows, not requested replacements", async () => {
  let disk = "context with private customer data\r\n\tA ‘quoted’ word\r\nend\r\n";
  const external = "/somewhere/temporary-workspace/file.txt";
  const io = [];
  // Only the actual SDK tool performs IO, over isolated memory operations.
  const sdkEdit = createEditTool("/project", {
    operations: {
      access: async (path) => {
        io.push(["access", path]);
      },
      readFile: async (path) => {
        io.push(["read", path]);
        return Buffer.from(disk);
      },
      writeFile: async (path, text) => {
        io.push(["write", path]);
        disk = text;
      },
    },
  });
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const activity = registry.track("editor-a", "/project");
  const emit = events(activity);
  const done = activity.begin();
  const input = {
    path: external,
    edits: [{ oldText: "\tA 'quoted' word", newText: "\tanother word\nnext line" }],
  };
  // The actual pinned SDK supplies the detail payload; explicit events model
  // Pi's start -> post-execution tool_result -> finalized end sequence.
  emit(start("pre-coercion.txt", "tool"));
  const toolResult = await sdkEdit.execute("tool", input);
  emit(result(external, "tool", "edit", { details: toolResult.details }));
  assert.equal(latestPatch(registry.listOwnerChanges(), external), undefined);
  emit(end("tool", "edit", { result: toolResult }));
  done();
  const snapshot = registry.listOwnerChanges();
  const patch = latestPatch(snapshot, external);
  assert.deepEqual(patch, {
    kind: "edit",
    added: 2,
    removed: 1,
    truncated: false,
    redacted: false,
    lines: [
      { kind: "remove", line: 2, text: "\\tA ‘quoted’ word" },
      { kind: "add", line: 2, text: "\\tanother word" },
      { kind: "add", line: 3, text: "next line" },
    ],
  });
  assert(!JSON.stringify(snapshot).includes("private customer data"));
  assert(!JSON.stringify(snapshot).includes("pre-coercion"));
  assert(!JSON.stringify(activity.snapshot()).includes("another word"));
  assert(io.every(([, path]) => path === external));
  assert.deepEqual(
    io.map(([operation]) => operation),
    ["access", "read", "write"],
  );
  assert.equal(
    disk,
    "context with private customer data\r\n\tanother word\r\nnext line\r\nend\r\n",
  );
  assert(Object.isFrozen(patch));
  assert(Object.isFrozen(patch.lines));
  assert(Object.isFrozen(patch.lines[0]));
});

test("pinned SDK zero-count and separated-hunk coordinates retain their actual line positions", async () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  const executeEdit = (path, before, edits) =>
    createEditTool("/project", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(before),
        writeFile: async () => {},
      },
    }).execute(path, { path, edits });
  const erase = await executeEdit("empty.txt", "remove whole file text", [
    { oldText: "remove whole file text", newText: "" },
  ]);
  assert.match(erase.details.patch, /^@@ -1,1 \+0,0 @@$/m);
  completeEdit(observe, "empty.txt", erase.details, "empty");
  assert.deepEqual(latestPatch(monitor.snapshot(), "/project/empty.txt"), {
    kind: "edit",
    added: 0,
    removed: 1,
    lines: [{ kind: "remove", line: 1, text: "remove whole file text", noLf: true }],
    truncated: false,
    redacted: false,
  });

  const before = Array.from({ length: 100 }, (_, i) => `line-${i + 1}\n`).join("");
  const distant = await executeEdit("distant.txt", before, [
    { oldText: "line-2\n", newText: "first\nsecond\n" },
    { oldText: "line-92\n", newText: "" },
  ]);
  assert.equal(distant.details.patch.match(/^@@/gm).length, 2);
  completeEdit(observe, "distant.txt", distant.details, "distant");
  const patch = latestPatch(monitor.snapshot(), "/project/distant.txt");
  assert.equal(patch.added, 2);
  assert.equal(patch.removed, 2);
  assert.deepEqual(patch.lines.at(-1), { kind: "remove", line: 92, text: "line-92" });

  const append = await executeEdit("eof.txt", "before", [
    { oldText: "before", newText: "first\nlast" },
  ]);
  assert.match(append.details.patch, /^\\ No newline at end of file$/m);
  completeEdit(observe, "eof.txt", append.details, "eof");
  const eof = groupFor(monitor.snapshot(), "/project/eof.txt");
  assert.equal(eof.reports[0].patch.kind, "edit");
  assert.deepEqual(eof.reports[0].patch.lines, [
    { kind: "remove", line: 1, text: "before", noLf: true },
    { kind: "add", line: 1, text: "first" },
    { kind: "add", line: 2, text: "last", noLf: true },
  ]);
  assert.equal(eof.net.kind, "edit");
  assert.equal(eof.net.added, 2);
});

test("counts sum net reports across paths; a known revert differs from no observations", async () => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const a = registry.track("a", "/project");
  const b = registry.track("b", "/project");
  const one = events(a),
    two = events(b);
  const aDone = a.begin(),
    bDone = b.begin();
  const notifications = [];
  const stop = registry.subscribeOwnerChangeCounts(() =>
    notifications.push(registry.getOwnerChangeCounts()),
  );
  const stopThrowing = registry.subscribeOwnerChangeCounts(() => {
    throw new Error("inert observer");
  });
  const initial = registry.getOwnerChangeCounts();
  const forward = patchDetails("file.txt", "@@ -1,1 +1,2 @@\n-a\n+b\n+c\n");
  const undo = patchDetails("file.txt", "@@ -1,2 +1,1 @@\n-b\n-c\n+a\n");

  two(start("./file.txt", "forward"));
  const pending = registry.getOwnerChangeCounts();
  two(result("file.txt", "forward", "edit", { details: forward }));
  assert.strictEqual(registry.getOwnerChangeCounts(), pending);
  two(end("forward", "edit", { result: { details: forward } }));
  const forwardNet = groupFor(registry.listOwnerChanges(), "/project/file.txt").net;
  assert.equal(forwardNet.kind, "edit");
  assert.equal(forwardNet.added, 2);
  assert.equal(forwardNet.removed, 1);

  completeEdit(one, "file.txt", undo, "undo");
  const reverted = groupFor(registry.listOwnerChanges(), "/project/file.txt");
  assert.deepEqual(reverted.net, { kind: "unchanged" });
  assert.deepEqual(
    reverted.reports.map(({ attempt }) => attempt.agentId),
    ["b", "a"],
  );
  assert.deepEqual(registry.getOwnerChangeCounts(), {
    paths: 1,
    attempts: 2,
    reported: 2,
    added: 0,
    removed: 0,
    unknownPaths: 0,
    partial: false,
  });
  assert.notDeepEqual(registry.getOwnerChangeCounts(), initial);

  completeEdit(
    two,
    "other.txt",
    patchDetails("other.txt", "@@ -0,0 +1,2 @@\n+first\n+second\n"),
    "other",
  );
  const beforeWrite = registry.listOwnerChanges();
  assert.deepEqual(registry.getOwnerChangeCounts(), {
    paths: 2,
    attempts: 3,
    reported: 3,
    added: 2,
    removed: 0,
    unknownPaths: 0,
    partial: false,
  });
  // Real write output doesn't include a trustworthy before-state; no raw
  // arguments (or pretend patch text attached to a write) can supply it.
  const writeTool = createWriteTool("/project", {
    operations: { mkdir: async () => {}, writeFile: async () => {} },
  });
  const writeInput = { path: "file.txt", content: "WRITE CONTENT NOT RETAINED" };
  one(start("file.txt", "write", "write"));
  const writeResult = await writeTool.execute("write", writeInput);
  one(result("file.txt", "write", "write", { input: writeInput, details: forward }));
  one(end("write", "write", { result: writeResult }));
  const afterWrite = groupFor(registry.listOwnerChanges(), "/project/file.txt");
  assert.deepEqual(afterWrite.net, { kind: "unavailable", reason: "write-no-before" });
  assert.deepEqual(afterWrite.reports.at(-1).patch, afterWrite.net);
  assert.equal(afterWrite.reports.length, 3);
  assert.deepEqual(registry.getOwnerChangeCounts(), {
    paths: 2,
    attempts: 4,
    reported: 4,
    added: 2,
    removed: 0,
    unknownPaths: 1,
    partial: false,
  });
  assert(!JSON.stringify(registry.listOwnerChanges()).includes(writeInput.content));
  assert.equal(latestPatch(beforeWrite, "/project/file.txt").removed, 2);
  const completeCounts = registry.getOwnerChangeCounts();
  assert.strictEqual(registry.getOwnerChangeCounts(), completeCounts);
  assert.strictEqual(notifications.at(-1), completeCounts);
  assert(Object.isFrozen(completeCounts));
  assert.equal(notifications.length, 10);
  aDone();
  bDone();
  registry.clear();
  assert.strictEqual(registry.getOwnerChangeCounts(), initial);
  assert.strictEqual(notifications.at(-1), initial);
  stop();
  stopThrowing();
  registry.clear();
  assert.equal(notifications.length, 11);
});

test("Reset clears Owner history, Net, footer counts and workspace hints without ending active Runs", () => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const empty = registry.listOwnerChanges();
  const zero = registry.getOwnerChangeCounts();
  const a = registry.track("a", "/project");
  const b = registry.track("b", "/project");
  const one = events(a),
    two = events(b);
  const entries = [{ id: "unchanged-transcript-entry" }];
  one({ type: "session_start" }, { sessionManager: { getEntries: () => entries } });
  const aDone = a.begin(),
    bDone = b.begin();
  const workspace = a.workspaceMonitor.watchRun();
  workspace.observe(start("unused", "old-hint", "bash"));
  workspace.observe(end("old-hint", "bash", { result: {} }));
  workspace.observe(start("unused", "late-hint", "bash"));
  assert.equal(a.workspaceSnapshot().length, 1);

  const path = "shared.txt";
  const old = patchDetails(path, "@@ -1,1 +1,2 @@\n-old\n+before reset\n+second line\n");
  const fresh = patchDetails(path, "@@ -1,1 +1,1 @@\n-fresh before\n+fresh after\n");
  completeEdit(one, path, old, "retained");
  const previous = registry.listOwnerChanges();
  one(start(path, "result-seen"));
  one(result(path, "result-seen", "edit", { details: old }));
  two(start(false, "start-only"));
  const active = a.snapshot();
  const revision = a.presentationRevision;
  const notices = [];
  const stop = registry.subscribeOwnerChangeCounts(() => {
    notices.push([registry.getOwnerChangeCounts(), a.workspaceSnapshot()]);
  });

  assert.equal(registry.resetChanges(registry.listOwnerChanges()), true);
  assert.equal(registry.resetChanges(empty), true);
  assert.strictEqual(registry.listOwnerChanges(), empty);
  assert.deepEqual(notices, [[zero, []]], "the footer sees the empty window immediately and once");
  assert.deepEqual(a.workspaceSnapshot(), []);
  assert(a.presentationRevision > revision);
  assert.deepEqual(a.snapshot(), active, "Reset does not interrupt or hide active tools");
  assert.strictEqual(a.entries(), entries);
  assert.equal(previous.groups[0].net.added, 2, "a previously issued snapshot stays immutable");

  // These are the same active Runs and even the same target, but only the new
  // edit contributes evidence. Finish the stale calls on both sides of it.
  one(end("result-seen", "edit", { result: { details: old } }));
  completeEdit(one, path, fresh, "fresh");
  const newSnapshot = registry.listOwnerChanges();
  const newCounts = registry.getOwnerChangeCounts();
  two(result(path, "start-only", "edit", { details: old }));
  two(end("start-only", "edit", { result: { details: old } }));
  one(result(path, "retained", "edit", { details: old }));
  one(end("retained", "edit", { result: { details: old } }));
  workspace.observe(end("late-hint", "bash", { result: {} }));
  assert.strictEqual(registry.listOwnerChanges(), newSnapshot);
  assert.strictEqual(registry.getOwnerChangeCounts(), newCounts);
  assert.deepEqual(newCounts, {
    paths: 1,
    attempts: 1,
    reported: 1,
    added: 1,
    removed: 1,
    unknownPaths: 0,
    partial: false,
  });
  assert.equal(newSnapshot.groups[0].reports.length, 1);
  assert.equal(newSnapshot.groups[0].net.lines.at(-1).text, "fresh after");
  assert.deepEqual(a.workspaceSnapshot(), []);

  two(start("lost-by-second-reset.txt", "in-between", "write"));
  registry.resetChanges(registry.listOwnerChanges());
  two(result("lost-by-second-reset.txt", "in-between", "write"));
  two(end("in-between", "write"));
  assert.strictEqual(registry.listOwnerChanges(), empty);
  completeEdit(two, path, fresh, "fresh-again");
  aDone();
  bDone();
  workspace.clear();
  stop();
  assert.equal(registry.listOwnerChanges().groups[0].reports[0].attempt.agentId, "b");
});

test("Owner Reset tokens track same-count hint changes across Runs and forget retired observations", (t) => {
  const registry = new ChildActivityRegistry();
  registry.enableOwnerChanges();
  const a = registry.track("a", "/project", "First", ["bash"]);
  const b = registry.track("b", "/project", "Second", ["bash"]);
  const watch = (child) => child.workspaceMonitor.watchRun();
  const shell = (toolCallId, command) => ({ ...start("", toolCallId, "bash"), args: { command } });
  const bashEnd = (toolCallId, exit_code = 0) =>
    end(toolCallId, "bash", {
      result: { structuredContent: { exit_code } },
    });
  const execute = (run, toolCallId, command, code) => {
    run.observe(shell(toolCallId, command));
    run.observe(bashEnd(toolCallId, code));
  };
  const one = watch(a),
    other = watch(b);
  const command = "git clone source /tmp/private-hint-fixture";
  const footer = t.mock.fn();
  registry.subscribeOwnerChangeCounts(footer);
  const snapshot = t.mock.method(a.workspaceMonitor, "snapshot");
  const reports = t.mock.method(OwnerChangeMonitor.prototype, "snapshot");
  const counts = registry.getOwnerChangeCounts();
  execute(one, "same", command);
  execute(other, "same", "cd /tmp/second-child");
  one.clear();
  assert(registry.hasOwnerChangeObservations());
  assert.strictEqual(registry.getOwnerChangeCounts(), counts);
  assert.equal(footer.mock.callCount(), 0);
  assert.equal(snapshot.mock.callCount(), 0);
  assert.equal(reports.mock.callCount(), 0, "hint deltas and footer reads do not project reports");

  const old = registry.listOwnerChanges();
  assert.deepEqual(old, { groups: [], truncated: false, workspaceHints: 2 });
  assert(Object.isFrozen(old));
  const two = watch(a);
  execute(two, "unrelated", "echo not-a-hint");
  two.observe(shell("same", command));
  assert.strictEqual(
    registry.listOwnerChanges(),
    old,
    "non-hints and pending Bash starts do not invalidate",
  );
  two.observe(bashEnd("same", 1));
  assert.equal(a.workspaceSnapshot()[0].bashExitZero, false, "the next Run may reuse an old ID");
  const replaced = registry.listOwnerChanges();
  assert.notStrictEqual(replaced, old, "equal hint counts do not make the old snapshot current");
  assert.strictEqual(registry.listOwnerChanges(), replaced);
  assert.deepEqual(replaced, old, "only count, not hint metadata, crosses into Changes");
  assert.strictEqual(registry.resetChanges(old), replaced);
  assert.equal(a.workspaceSnapshot().length, 1, "stale Reset did not clear anything");

  two.observe(shell("tail", "cd /tmp/pre-reset-a"));
  other.observe(shell("tail", "cd /tmp/pre-reset-b"));
  assert.equal(registry.resetChanges(replaced), true);
  two.observe(bashEnd("tail"));
  other.observe(bashEnd("tail"));
  assert(!registry.hasOwnerChangeObservations(), "Reset fences pending hints in all its Runs");
  execute(two, "new", "cd /tmp/fresh-a");
  execute(other, "new", "cd /tmp/fresh-b");
  const both = registry.listOwnerChanges();
  assert.equal(both.workspaceHints, 2);
  registry.retain(new Set(["b"]));
  const remaining = registry.listOwnerChanges();
  assert.equal(remaining.workspaceHints, 1, "the Reset scope follows retained observations");
  assert.strictEqual(registry.resetChanges(both), remaining);
  const replacement = registry.track("a", "/project", "Replacement", ["bash"]);
  execute(two, "stale", command);
  execute(watch(a), "also-stale", command);
  assert.strictEqual(registry.listOwnerChanges(), remaining);
  const fresh = watch(replacement);
  execute(fresh, "same", command);
  assert.equal(registry.listOwnerChanges().workspaceHints, 2);
  registry.clear();
  execute(other, "stale", command);
  execute(fresh, "stale", command);
  assert(!registry.hasOwnerChangeObservations());
  assert.equal(registry.listOwnerChanges().workspaceHints, 0);
  assert.equal(footer.mock.callCount(), 0, "workspace hints do not trigger a footer update");
});

test("Reset reopens the pending budget but keeps omitted and prior IDs fenced", () => {
  const monitor = new OwnerChangeMonitor();
  const run = monitor.bind("id", "alpha", "/project")();
  for (let i = 0; i < 32; i++) run.observe(start(`pending-${i}`, `id-${i}`));
  run.observe(start("omitted.txt", "overflow"));
  run.observe(start("invalid.txt", "x".repeat(257)));
  assert(monitor.getCounts().partial);
  monitor.reset();

  const path = "fresh.txt";
  const details = patchDetails(path, "@@ -1,1 +1,1 @@\n-old\n+new\n");
  const empty = monitor.snapshot();
  run.observe(result(path, "unseen-result", "edit", { details }));
  run.observe(end("unseen-end"));
  assert.strictEqual(monitor.snapshot(), empty, "unseen tails do not create coverage gaps");
  completeEdit(run.observe, path, details, "fresh");
  const fresh = monitor.snapshot();
  for (const id of ["id-0", "overflow", "x".repeat(257)]) {
    run.observe(result(path, id, "edit", { details }));
    run.observe(end(id, "edit", { result: { details } }));
  }
  assert.strictEqual(monitor.snapshot(), fresh);
  assert.equal(monitor.getCounts().added, 1);

  for (const id of ["id-0", "overflow", "unseen-result", "unseen-end"]) {
    run.observe(start("unsafe-reuse.txt", id));
    const rejected = monitor.snapshot();
    run.observe(result("unsafe-reuse.txt", id));
    run.observe(end(id));
    assert.strictEqual(monitor.snapshot(), rejected, "late tails are inert even after reuse");
    assert.equal(rejected.groups.length, 1);
    assert.equal(rejected.groups[0].net.reason, "ambiguous");
  }
  run.clear();
});

test("at the Run ID cap, an unseen Reset tail does not affect matched fresh edits", () => {
  const monitor = new OwnerChangeMonitor();
  const bind = monitor.bind("id", "alpha", "/project");
  const run = bind();
  monitor.reset();
  for (let i = 0; i < 255; i++) run.observe(end(`old-${i}`));
  assert.deepEqual(monitor.snapshot(), { groups: [], truncated: false });
  const path = "last-admitted.txt";
  const details = patchDetails(path, "@@ -1,1 +1,1 @@\n-before\n+after\n");
  run.observe(start(path, "fresh"));
  run.observe(end("unseen-at-cap"));
  run.observe(result(path, "fresh", "edit", { details }));
  run.observe(end("fresh", "edit", { result: { details } }));
  assert.equal(monitor.getCounts().partial, false);
  assert.equal(monitor.getCounts().added, 1);

  monitor.reset();
  completeEdit(run.observe, path, details, "unseen-at-cap");
  assert.deepEqual(monitor.snapshot(), { groups: [], truncated: true });
  run.clear();
  monitor.reset();
  const next = bind();
  completeEdit(next.observe, path, details, "unseen-at-cap");
  next.clear();
  assert.equal(monitor.getCounts().added, 1);
});

test("provisional targets mask Net until the effective target is known", () => {
  const monitor = new OwnerChangeMonitor();
  const known = monitor.bind("known", "alpha", "/project")();
  const run = monitor.bind("changing", "beta", "/project")();
  const path = "verified.txt";
  completeEdit(known.observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n"));
  const before = groupFor(monitor.snapshot(), `/project/${path}`).net;
  assert.equal(before.kind, "edit");
  run.observe(start("provisional.txt"));
  assert.equal(monitor.getCounts().added, 0);
  assert.equal(monitor.snapshot().truncated, false);
  run.observe(result("different-effective.txt"));
  assert.equal(monitor.getCounts().added, 1);
  assert.strictEqual(groupFor(monitor.snapshot(), `/project/${path}`).net, before);
  run.clear(); // The path is known, so only its own report is missing.
  assert.equal(monitor.snapshot().truncated, false);
  assert.equal(
    groupFor(monitor.snapshot(), "/project/different-effective.txt").net.kind,
    "unavailable",
  );
  assert.strictEqual(groupFor(monitor.snapshot(), `/project/${path}`).net, before);
});

test("rewritten paths and multiple provisional calls update local totals and display order", () => {
  const monitor = new OwnerChangeMonitor();
  const run = monitor.bind("id", "alpha", "/project")();
  const { observe } = run;
  const known = "known.txt";
  observe(start("provisional.txt", "older"));
  completeEdit(observe, known, patchDetails(known, "@@ -0,0 +1,2 @@\n+a\n+b\n"), "known");
  observe(start(false, "unknown"));
  assert.equal(monitor.getCounts().partial, true);
  assert.equal(monitor.getCounts().unknownPaths, 2);
  observe(result("different.txt", "unknown"));
  assert.equal(monitor.getCounts().partial, false);
  assert.equal(monitor.getCounts().unknownPaths, 3, "the other provisional path still masks Net");
  observe(result(known, "older"));
  assert.deepEqual(
    monitor.snapshot().groups.map(({ path }) => path),
    ["/project/different.txt", "/project/known.txt"],
  );
  assert.equal(monitor.getCounts().paths, 2);
  assert.equal(monitor.getCounts().attempts, 3);
  assert.equal(monitor.getCounts().added, 0, "the unresolved attempt masks only its own path");
  observe(end("unknown", "edit", { isError: true }));
  observe(end("older", "edit", { isError: true }));
  run.clear();
  assert.equal(monitor.getCounts().unknownPaths, 2);
});

test("a possible mutation without effective target invalidates even unrelated Net after Run clear or timed end", () => {
  for (const finish of [
    (run) => run.clear(),
    (run) => run.observe(end()),
    (run) => run.observe(end("call", "edit", { isError: true })),
  ]) {
    const monitor = new OwnerChangeMonitor();
    const bind = monitor.bind("id", "alpha", "/project");
    const first = bind();
    const path = "verified.txt";
    completeEdit(first.observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n"));
    first.clear();
    const second = bind();
    second.observe(start("provisional.txt"));
    finish(second);
    const snapshot = monitor.snapshot();
    assert.equal(snapshot.truncated, true);
    const group = groupFor(snapshot, `/project/${path}`);
    assert.deepEqual(group.net, { kind: "unavailable", reason: "incomplete" });
    assert.equal(
      group.reports[0].patch.kind,
      "edit",
      "the earlier report remains independently verified",
    );
    assert.equal(monitor.getCounts().unknownPaths, 2);
  }
});

test("same-path overlap preserves completion order in Reports but contributes no Net counts", () => {
  const monitor = new OwnerChangeMonitor();
  const a = monitor.bind("a", "alpha", "/project")();
  const b = monitor.bind("b", "beta", "/project")();
  const forward = patchDetails("file.txt", "@@ -1,1 +1,1 @@\n-a\n+b\n");
  const undo = patchDetails("file.txt", "@@ -1,1 +1,1 @@\n-b\n+a\n");
  a.observe(start("wrong-before-hook.txt"));
  completeEdit(b.observe, "file.txt", forward);
  a.observe(result("file.txt", "call", "edit", { details: undo }));
  a.observe(end("call", "edit", { result: { details: undo } }));
  const group = groupFor(monitor.snapshot(), "/project/file.txt");
  assert.deepEqual(group.net, { kind: "unavailable", reason: "overlapping" });
  assert.deepEqual(
    group.reports.map(({ attempt }) => attempt.agentId),
    ["b", "a"],
  );
  assert.deepEqual(monitor.getCounts(), {
    paths: 1,
    attempts: 2,
    reported: 2,
    added: 0,
    removed: 0,
    unknownPaths: 1,
    partial: false,
  });
});

test("pre-execution failures remain in History without creating changes or uncertainty", () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  observe(start("denied.txt", "denied", "write"));
  observe(end("denied", "write", { isError: true, durationMs: undefined }));
  assert.deepEqual(monitor.snapshot(), {
    groups: [
      {
        path: "/project/denied.txt",
        reports: [{ attempt: attempt("id", "alpha", "write", "failed") }],
        net: { kind: "unchanged" },
      },
    ],
    truncated: false,
  });
  assert.deepEqual(monitor.getCounts(), {
    paths: 1,
    attempts: 1,
    reported: 0,
    added: 0,
    removed: 0,
    unknownPaths: 0,
    partial: false,
  });
});

test("pathless pre-execution rejections clear only their temporary Net mask", () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  const path = "verified.txt";
  completeEdit(observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n"), "verified");
  const before = monitor.snapshot();
  const counts = monitor.getCounts();
  assert.equal(counts.added, 1);

  observe(start(undefined, "missing-path"));
  observe(start(false, "invalid-path", "write"));
  assert.deepEqual(monitor.getCounts(), {
    ...counts,
    added: 0,
    removed: 0,
    unknownPaths: 1,
    partial: true,
  });
  assert.deepEqual(monitor.snapshot().groups[0].net, { kind: "unavailable", reason: "incomplete" });
  observe(rejectBeforeExecution("missing-path"));
  assert.equal(monitor.snapshot().truncated, true, "another pathless call is still unresolved");
  observe(rejectBeforeExecution("invalid-path", "write"));
  assert.deepEqual(monitor.snapshot(), before);
  assert.strictEqual(monitor.snapshot().groups[0].net, before.groups[0].net);
  assert.deepEqual(monitor.getCounts(), counts);

  observe(rejectBeforeExecution("missing-path"));
  assert.equal(
    monitor.snapshot().groups[0].net.reason,
    "ambiguous",
    "a duplicate end stays fenced",
  );
  assert.equal(monitor.getCounts().partial, true);
});

test("pathless outcomes that do not confirm a matched pre-execution rejection retain the gap", () => {
  const endWith = (overrides) => (run) => run.observe(end("pathless", "edit", overrides));
  for (const [name, finish, reason = "incomplete"] of [
    ["timed failure", endWith({ isError: true })],
    ["untimed success", endWith({ durationMs: undefined })],
    ["malformed timing", endWith({ isError: true, durationMs: null })],
    ["malformed status", endWith({ isError: "true", durationMs: undefined })],
    [
      "accessor timing",
      (run) =>
        run.observe(
          Object.defineProperty(rejectBeforeExecution("pathless"), "durationMs", {
            get: () => undefined,
          }),
        ),
    ],
    [
      "post-execution result",
      (run) => {
        run.observe(result(undefined, "pathless", "edit", { isError: true }));
        run.observe(rejectBeforeExecution("pathless"));
      },
    ],
    [
      "unmatched end",
      (run) => {
        run.observe(rejectBeforeExecution("unmatched"));
        run.observe(rejectBeforeExecution("pathless"));
      },
    ],
    ["wrong tool", (run) => run.observe(rejectBeforeExecution("pathless", "write")), "ambiguous"],
    [
      "malformed event type",
      endWith({ type: "unexpected", isError: true, durationMs: undefined }),
      "ambiguous",
    ],
    ["no end", (run) => run.clear()],
  ]) {
    const monitor = new OwnerChangeMonitor();
    const run = monitor.bind("id", "alpha", "/project")();
    const path = "verified.txt";
    completeEdit(run.observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n"), "verified");
    run.observe(start(undefined, "pathless"));
    finish(run);
    run.clear();
    const { groups, truncated } = monitor.snapshot();
    assert.equal(truncated, true, name);
    assert.deepEqual(groups[0].net, { kind: "unavailable", reason }, name);
    assert.equal(groups[0].reports[0].patch.kind, "edit", name);
    assert.equal(monitor.getCounts().added, 0, name);
  }
});

test("Net composes a sequence, ignores pre-execution denials, and fences uncertain failures", () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  const path = "file.txt";
  completeEdit(observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n"), "first");
  observe(start(path, "denied", "write"));
  observe(end("denied", "write", { isError: true, durationMs: undefined }));
  completeEdit(observe, path, patchDetails(path, "@@ -1,1 +1,1 @@\n-b\n+c\n"), "second");
  const proven = groupFor(monitor.snapshot(), `/project/${path}`);
  assert.deepEqual(proven.net, {
    kind: "edit",
    added: 1,
    removed: 1,
    lines: [
      { kind: "remove", line: 1, text: "a" },
      { kind: "add", line: 1, text: "c" },
    ],
  });
  assert.deepEqual(proven.reports[1], { attempt: attempt("id", "alpha", "write", "failed") });
  observe(start(path, "timed-failure", "write"));
  observe(result(path, "timed-failure", "write", { isError: true }));
  observe(end("timed-failure", "write", { isError: true }));
  const blocked = groupFor(monitor.snapshot(), `/project/${path}`);
  assert.deepEqual(blocked.net, { kind: "unavailable", reason: "incomplete" });
  assert.deepEqual(blocked.reports.at(-1), { attempt: attempt("id", "alpha", "write", "failed") });
  assert.strictEqual(proven.net.kind, "edit", "the already-open snapshot is unchanged");
});

test("retained later reports cannot revive Net after an older report for their path was evicted", () => {
  const monitor = new OwnerChangeMonitor();
  const watch = monitor.bind("id", "alpha", "/project");
  const first = watch();
  const path = "repeated.txt";
  const forward = patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n");
  const undo = patchDetails(path, "@@ -1,1 +1,1 @@\n-b\n+a\n");
  completeEdit(first.observe, path, forward, "first");
  first.clear();
  for (let offset = 0; offset < 511; offset += 256) {
    const run = watch();
    for (let i = offset; i < Math.min(offset + 256, 511); i++)
      complete(run.observe, `filler-${i}`, `id-${i}`);
    run.clear();
  }
  assert.equal(groupFor(monitor.snapshot(), `/project/${path}`).net.kind, "edit");
  const last = watch();
  completeEdit(last.observe, path, undo, "undo");
  completeEdit(
    last.observe,
    "other.txt",
    patchDetails("other.txt", "@@ -0,0 +1,1 @@\n+fresh\n"),
    "other",
  );
  last.clear();
  const snapshot = monitor.snapshot();
  const group = groupFor(snapshot, `/project/${path}`);
  assert.deepEqual(group.net, { kind: "unavailable", reason: "truncated" });
  assert.equal(group.reports.length, 1);
  assert.equal(groupFor(snapshot, "/project/other.txt").net.kind, "edit");
  assert.equal(snapshot.truncated, true);
  assert.equal(monitor.getCounts().added, 1);
  assert.equal(monitor.getCounts().removed, 0);

  monitor.reset();
  const next = watch();
  completeEdit(next.observe, path, undo, "after-reset");
  next.clear();
  assert.equal(groupFor(monitor.snapshot(), `/project/${path}`).net.kind, "edit");
  assert.equal(monitor.snapshot().truncated, false);
});

test("pathless starts do not evict retained reports until they acquire an effective path", () => {
  const monitor = new OwnerChangeMonitor();
  const watch = monitor.bind("id", "alpha", "/project");
  const first = watch();
  const path = "oldest.txt";
  const details = patchDetails(path, "@@ -1,1 +1,1 @@\n-a\n+b\n");
  completeEdit(first.observe, path, details);
  first.clear();
  for (const [batch, count] of [256, 255].entries()) {
    const filler = watch();
    for (let i = 0; i < count; i++) complete(filler.observe, `filler-${batch}-${i}`, `id-${i}`);
    filler.clear();
  }
  const full = monitor.snapshot();
  const counts = monitor.getCounts();
  assert.equal(counts.attempts, 512);
  assert.equal(counts.added, 1);
  assert.equal(counts.partial, false);

  const run = watch();
  run.observe(start(undefined, "rejected"));
  assert.equal(monitor.getCounts().attempts, 512);
  assert.equal(monitor.getCounts().partial, true);
  assert(groupFor(monitor.snapshot(), `/project/${path}`), "the oldest report is still retained");
  run.observe(rejectBeforeExecution("rejected"));
  assert.deepEqual(monitor.snapshot(), full);
  assert.deepEqual(monitor.getCounts(), counts);

  run.observe(start(undefined, "rewritten"));
  run.observe(result("recovered.txt", "rewritten"));
  run.observe(end("rewritten"));
  assert(
    !groupFor(monitor.snapshot(), `/project/${path}`),
    "retaining an actual path evicts normally",
  );
  assert.equal(monitor.getCounts().attempts, 512);
  assert.equal(monitor.getCounts().partial, true);

  run.observe(start(undefined, "pending-at-reset"));
  monitor.reset();
  run.observe(rejectBeforeExecution("pending-at-reset"));
  run.observe(rejectBeforeExecution("rejected"));
  assert.deepEqual(monitor.snapshot(), { groups: [], truncated: false });
  completeEdit(run.observe, path, details, "new");
  assert.equal(monitor.getCounts().added, 1);
  assert.equal(monitor.getCounts().partial, false, "Reset clears the real eviction gap too");
  run.observe(start(path, "rejected"));
  assert.equal(
    monitor.snapshot().groups[0].net.reason,
    "ambiguous",
    "the denied ID cannot be reused",
  );
  run.clear();
});

test("evicted in-flight calls keep ID fences but do not inspect late payloads", () => {
  const monitor = new OwnerChangeMonitor();
  const watch = monitor.bind("id", "alpha", "/project");
  const pending = watch();
  pending.observe(start("evicted.txt", "old"));
  for (let batch = 0; batch < 2; batch++) {
    const filler = watch();
    for (let i = 0; i < 256; i++) complete(filler.observe, `filler-${batch}-${i}`, `id-${i}`);
    filler.clear();
  }
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.groups.length, 512);
  assert.equal(monitor.getCounts().partial, true);
  assert(!groupFor(snapshot, "/project/evicted.txt"));
  let reads = 0;
  pending.observe({
    type: "tool_result",
    toolName: "edit",
    toolCallId: "old",
    get input() {
      reads++;
      return { path: "not inspected" };
    },
  });
  pending.observe({
    type: "tool_execution_end",
    toolName: "edit",
    toolCallId: "old",
    get isError() {
      reads++;
      return false;
    },
  });
  assert.equal(reads, 0);
  assert.strictEqual(monitor.snapshot(), snapshot);
  monitor.reset();
  complete(pending.observe, "not readmitted.txt", "old");
  assert.deepEqual(monitor.snapshot(), { groups: [], truncated: true });
  pending.clear();
});

test("requiring intact timed matched success rejects failed, replaced, ambiguous and malformed details", () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  const hunk = "@@ -1,1 +1,1 @@\n-before\n+private data\n";
  const valid = patchDetails("target", hunk);
  for (const [index, [pre, post]] of [
    [valid, patchDetails("target", hunk.replace("before", "instead"))],
    [patchDetails("malformed", hunk.replace("-1,1", "-1,2")), undefined],
    [patchDetails("malformed", hunk + "--- other\n+++ other\n"), undefined],
    [patchDetails("malformed", "@@ -0,1 +1,1 @@\n-previous\n+bad coordinate\n"), undefined],
    [patchDetails("malformed", "@@ -1,1 +99,1 @@\n-previous\n+bad initial gap\n"), undefined],
    [patchDetails("malformed", hunk + "@@ -21,1 +22,1 @@\n-previous\n+bad later gap\n"), undefined],
    [patchDetails("malformed", "@@ -0,0 +2,1 @@\n+bad zero-count gap\n"), undefined],
    [patchDetails("malformed", "@@ -01,1 +1,1 @@\n-previous\n+bad leading zero\n"), undefined],
    [patchDetails("malformed", "@@ -NaN,99 +1,1 @@\n-previous\n+bad coordinate\n"), undefined],
    [
      patchDetails(
        "malformed",
        "@@ -1,2 +1,1 @@\n-old\n\\ No newline at end of file\n-after\n+new\n",
      ),
      undefined,
    ],
    [
      patchDetails(
        "malformed",
        "@@ -1,1 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n+after\n",
      ),
      undefined,
    ],
    [
      patchDetails(
        "malformed",
        "@@ -1,2 +1,2 @@\n context\n\\ No newline at end of file\n-old\n+new\n",
      ),
      undefined,
    ],
    [
      patchDetails(
        "malformed",
        "@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n@@ -4,0 +5,1 @@\n+gap past EOF\n",
      ),
      undefined,
    ],
    [
      patchDetails(
        "malformed",
        "@@ -1,1 +1,1 @@\n-old\n+new\n\\ No newline at end of file\n@@ -5,1 +4,0 @@\n-gap past EOF\n",
      ),
      undefined,
    ],
    [patchDetails("elsewhere", hunk), undefined],
  ].entries()) {
    const path = index === 0 ? "target" : "malformed";
    completeEdit(observe, path, pre, `test-${index}`, post ?? pre);
    assert.deepEqual(latestPatch(monitor.snapshot(), `/project/${path}`), {
      kind: "unavailable",
      reason: "missing-or-unverified",
    });
  }
  for (const [id, resultChanges, endChanges] of [
    ["failed", {}, { isError: true }],
    ["not-timed", {}, { durationMs: undefined }],
    ["rewritten-error", { isError: true }, { isError: false }],
  ]) {
    const details = patchDetails(id, hunk);
    observe(start(id, id));
    observe(result(id, id, "edit", { details, ...resultChanges }));
    observe(end(id, "edit", { result: { details }, ...endChanges }));
    assert.equal(latestPatch(monitor.snapshot(), `/project/${id}`), undefined);
  }
  const details = patchDetails("ambiguous", hunk);
  completeEdit(observe, "ambiguous", details, "ambiguous");
  assert.equal(latestPatch(monitor.snapshot(), "/project/ambiguous").kind, "edit");
  observe(end("ambiguous", "write"));
  assert.equal(latestPatch(monitor.snapshot(), "/project/ambiguous"), undefined);
  assert.equal(monitor.getCounts().partial, true);
  assert(!JSON.stringify(monitor.snapshot()).includes("private data"));
});

test("bounded edit preview drops context, suppresses sensitive or unsafe data, and retains complete short-patch counts", () => {
  const monitor = new OwnerChangeMonitor();
  const { observe } = monitor.bind("id", "alpha", "/project")();
  for (const [path, hunks, reason] of [
    ["/elsewhere/.env.local", "@@ -1,1 +1,1 @@\n-credential-old\n+credential-new\n", "sensitive"],
    ["/elsewhere/.secrets/public.txt", "@@ -1,1 +1,1 @@\n-before\n+unmarked after\n", "sensitive"],
    ["folder/.CREDENTIALS", "@@ -1,1 +1,1 @@\n-before\n+unmarked after\n", "sensitive"],
    ["unsafe", "@@ -1,1 +1,1 @@\n-before\n+\x1b]52;private protocol payload\n", "sensitive"],
    [
      "key-data.txt",
      "@@ -1,2 +1,2 @@\n -----BEGIN OPENSSH PRIVATE KEY-----\n-before\n+private body\n",
      "sensitive",
    ],
    [
      "values.yaml",
      "@@ -1,2 +1,2 @@\n password: |\n-  unmarked before\n+  unmarked after\n",
      "sensitive",
    ],
    [
      "values.json",
      '@@ -1,2 +1,2 @@\n-  "name":\n-    "public before"\n+  "token":\n+    "unmarked JSON value"\n',
      "sensitive",
    ],
    [
      "synthetic.sh",
      "@@ -1,2 +1,2 @@\n-api_token='demo only\n-synthetic continuation before'\n+api_token='demo only\n+synthetic continuation after'\n",
      "sensitive",
    ],
    [
      "escaped-quote.sh",
      '@@ -1,2 +1,2 @@\n-api_token="demo \\"quoted\\"\n-synthetic continuation before"\n+api_token="demo \\"quoted\\"\n+synthetic continuation after"\n',
      "sensitive",
    ],
    ["too-big", `@@ -1,1 +1,1 @@\n-before\n+${"x".repeat(64 * 1024)}\n`, "oversized"],
    ["long-line", `@@ -1,1 +1,1 @@\n-before\n+${"x".repeat(1025)}\n`, "oversized"],
    ["long-context", `@@ -1,2 +1,2 @@\n ${"x".repeat(1025)}\n-before\n+after\n`, "oversized"],
  ]) {
    completeEdit(observe, path, patchDetails(path, hunks), path);
    assert.deepEqual(
      latestPatch(monitor.snapshot(), path.startsWith("/") ? path : `/project/${path}`),
      { kind: "unavailable", reason },
    );
  }
  const many = Array.from({ length: 28 }, (_, i) => `+line ${i}\n`).join("");
  const normal = "normal.txt";
  completeEdit(
    observe,
    normal,
    patchDetails(
      normal,
      `@@ -9,1 +9,32 @@\n-known\n+Bearer synthetic_bearer_value\n+safe\u202eRTL\u2028separator\tindent\\literal\n+${"😊".repeat(200)}\n+visible\n${many}`,
    ),
    normal,
  );
  const patch = latestPatch(monitor.snapshot(), `/project/${normal}`);
  assert.equal(patch.added, 32);
  assert.equal(patch.removed, 1);
  assert.equal(patch.lines.length, 24);
  assert.deepEqual(patch.lines.slice(0, 3), [
    { kind: "remove", line: 9, text: "known" },
    { kind: "add", line: 9, text: "[possible credential withheld]" },
    { kind: "add", line: 10, text: "safe\\u202eRTL\\u2028separator\\tindent\\\\literal" },
  ]);
  assert.match(patch.lines[3].text, /…$/u);
  assert.doesNotMatch(patch.lines[3].text, /\p{Cs}/u);
  assert.equal(patch.truncated, true);
  assert.equal(patch.redacted, true);
  assert.equal(monitor.getCounts().unknownPaths, 13);
  assert.equal(monitor.getCounts().added, 0);
  assert.deepEqual(groupFor(monitor.snapshot(), `/project/${normal}`).net, {
    kind: "unavailable",
    reason: "sensitive",
  });
  assert.doesNotMatch(
    JSON.stringify(monitor.snapshot()),
    /synthetic_bearer_value|unmarked (?:JSON|before|after)|synthetic continuation/u,
  );
});
