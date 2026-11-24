import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Exercise the source without writing a shared dist/ or generated/ tree.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { WorkspaceMonitor } = await jiti.import(
  "../../src/orchestration/runtime/workspace-monitor.ts",
);
const { PiAgentSessionAdapter, ChildRunGate } = await jiti.import(
  "../../src/orchestration/runtime/agent-session.ts",
);
const { ChildActivity } = await jiti.import("../../src/orchestration/runtime/activity-observer.ts");
const { renderDetailInfo, renderDetailSummary } = await jiti.import(
  "../../src/orchestration/ui/agent-detail-fields.ts",
);

const start = (command, toolCallId = "call", toolName = "bash") => ({
  type: "tool_execution_start",
  toolName,
  toolCallId,
  args: { command },
});
const end = (toolCallId = "call", overrides = {}) => ({
  type: "tool_execution_end",
  toolName: "bash",
  toolCallId,
  isError: false,
  durationMs: 3,
  result: { structuredContent: { exit_code: 0, output: "output not retained" } },
  ...overrides,
});
let nextCall = 0;
const emit = (run, command, overrides) => {
  const id = `call-${++nextCall}`;
  run.observe(start(command, id));
  run.observe(end(id, overrides));
};

const clone = (path, bashExitZero) => ({ kind: "clone", path, bashExitZero });
const cd = (path) => ({ kind: "cd", path, bashExitZero: false });

test("records Bash exit 0 for matched standalone clone and worktree requests, retaining only path metadata", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  run.observe(
    start(`git clone --depth 1 -b private-branch -- 'https://secret@host/source' '/tmp/a b'`),
  );
  assert.deepEqual(monitor.snapshot(), []);
  run.observe(end("wrong-call"));
  assert.deepEqual(monitor.snapshot(), []);
  run.observe(end());
  emit(run, "git worktree add --detach ./link/../worktree HEAD\n");
  assert.deepEqual(monitor.snapshot(), [
    { kind: "worktree", path: "./link/../worktree", bashExitZero: true },
    clone("/tmp/a b", true),
  ]);
  const snapshot = monitor.snapshot();
  assert(Object.isFrozen(snapshot) && snapshot.every(Object.isFrozen));
  assert.throws(() => {
    snapshot[0].path = "/different";
  }, TypeError);
});

test("recognizes a temporary clone reference without guessing or retaining shell data", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  emit(
    run,
    'ephemeral="$(mktemp -d)" &&\n' +
      'git clone --depth=1 "$SOURCE_URL" "${ephemeral}/repo" && ' +
      'cd "$ephemeral/repo" && git log -1',
  );
  assert.deepEqual(monitor.snapshot(), [{ kind: "temporary clone" }]);

  emit(run, "git clone source /tmp/concrete && cd /tmp/concrete; git -C /tmp/concrete status");
  assert.deepEqual(monitor.snapshot(), [
    { kind: "git -C", path: "/tmp/concrete", bashExitZero: false },
    { kind: "cd", path: "/tmp/concrete", bashExitZero: false },
    clone("/tmp/concrete", false),
    { kind: "temporary clone" },
  ]);
});

test("observes literal cd in redirected command sequences with an exit-status assignment", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  const tail = `; RC=$?; printf 'Result; cd /tmp/not-a-command: %s' "$RC"; tail -n 8 build.log; exit "$RC"`;
  emit(
    run,
    `pwd; cd '/tmp/replay path' && A=fast B=prefix$MODE make build > build.log 2>&1${tail}`,
  );
  emit(run, `cd ./relative && A=fast B=prefix$MODE make build#part >build.log 2>&1${tail}`);
  emit(
    run,
    `cd /tmp/failed && A=fast B=prefix\${MODE} make target=part#section >>build.log 2>&1${tail}`,
    {
      isError: true,
      result: { structuredContent: { exit_code: 2 } },
    },
  );
  assert.deepEqual(monitor.snapshot(), [
    cd("/tmp/failed"),
    cd("./relative"),
    cd("/tmp/replay path"),
  ]);
});

test("skips supported redirects and line comments without adding argv or Git evidence", () => {
  for (const [command, path] of [
    ["2>/dev/null cd 2 >log", "2"],
    ["cd </tmp/in 'some dir'>out 3<&-", "some dir"],
    ["cd /tmp/adjacent&>>log", "/tmp/adjacent"],
    ["&>log cd /tmp/prefix", "/tmp/prefix"],
    ["cd /tmp/one<>in-out >|log", "/tmp/one"],
    ["printf '<<EOF; cd /tmp/prose' >'log; cd /tmp/target'; cd ./real", "./real"],
    ["true >cd && # <<EOF; cd /tmp/comment\n 2>>other && cd /tmp/next # cd /tmp/no", "/tmp/next"],
    [
      "git clone secret /tmp/clone; cd /tmp/hint && git worktree add /tmp/worktree >log",
      "/tmp/hint",
    ],
  ]) {
    const monitor = new WorkspaceMonitor();
    emit(monitor.watchRun(), command);
    assert.deepEqual(monitor.snapshot(), [cd(path)], command);
  }
});

test("keeps word-internal hashes opaque without mistaking token-initial hashes for arguments", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  emit(run, "git clone source#ref /tmp/not-observed; cd ./real");
  emit(run, "printf word#tag # still a comment; cd /tmp/not-run\ncd ./next");
  assert.deepEqual(monitor.snapshot(), [cd("./next"), cd("./real")]);
});

test("does not recover cd from shell data or partially scanned unsupported input", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  for (const command of [
    ">cd /tmp/not-a-command",
    "2>cd /tmp/not-a-command",
    "cd 2>log",
    "cd >'/tmp/not-an-operand'",
    "printf >'log; cd /tmp/not-a-command'",
    "echo cd /tmp/argument >log",
    "# cd /tmp/comment >/dev/null",
    "cd /tmp/hash#not-a-path-hint >log",
    "cd '/tmp/hash#not-a-path-hint' >log",
    "cd /tmp/not-observed && printf word#tag | true",
    "cd /tmp/not-observed; cat <<'EOF'\ncd /tmp/in-body\nEOF\ncd /tmp/after",
    "cd /tmp/not-observed; cat <<-EOF\n\tcd /tmp/in-body\n\tEOF",
    "cd /tmp/not-observed; cat <<< 'cd /tmp/data'",
    "cd /tmp/not-observed && echo >",
    "cd /tmp/not-observed >$OUT",
    "cd /tmp/not-observed >'partial'joined",
    "cd /tmp/not-observed >out#joined",
    "cd /tmp/not-observed > >(other)",
    "cd /tmp/not-observed | true >log",
    "cd /tmp/not-observed && (echo >log)",
    "cd /tmp/not-observed >log && RC=$?suffix",
    "cd /tmp/not-observed >log && # unfinished list",
    'cd "$DIR" >log',
  ]) {
    emit(run, command);
    assert.deepEqual(monitor.snapshot(), [], command);
  }
});

test("a newer attempt does not inherit the earlier Bash exit result", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  const command = "git clone source /tmp/concrete";
  emit(run, command);
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/concrete", true)]);
  emit(run, command, { isError: true });
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/concrete", false)]);
  emit(run, command);
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/concrete", true)]);
  emit(run, `${command} && true`);
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/concrete", false)]);

  run.observe(start(command, "older"));
  run.observe(start(command, "newer"));
  run.observe(end("newer", { isError: true }));
  run.observe(end("older"));
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/concrete", false)]);
});

test("blocked, mismatched, dropped and ambiguous events never report Bash exit 0", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  emit(run, "git clone source blocked", { durationMs: undefined, isError: true });
  run.observe(start("git clone source wrong-tool", "other", "grep"));
  run.observe(end("other"));
  run.observe(start("git clone source duplicate", "twice"));
  run.observe(start("echo unrelated", "twice"));
  run.observe(end("twice"));
  assert.deepEqual(monitor.snapshot(), []);

  emit(run, "git clone source failed", { isError: true });
  emit(run, "git clone source no-structured-exit", { result: { content: [{ text: "worked" }] } });
  emit(run, "git clone source nonzero", { result: { structuredContent: { exit_code: 1 } } });
  emit(run, "git clone $SOURCE possibly-reassigned-operand");
  assert.deepEqual(monitor.snapshot(), [
    clone("possibly-reassigned-operand", false),
    clone("nonzero", false),
    clone("no-structured-exit", false),
    clone("failed", false),
  ]);
});

test("ignores nested, data, unsupported, implicit and over-limit shell forms", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  for (const command of [
    `echo 'git clone secret /tmp/mentioned; cd /tmp/mentioned'`,
    `echo "git clone secret /tmp/mentioned; cd /tmp/mentioned"`,
    `bash -c 'git clone secret /tmp/nested'`,
    `echo "$(mktemp -d; git clone secret /tmp/nested)"`,
    "cat <<END\ngit clone secret /tmp/heredoc\nEND",
    "if false; then git clone secret /tmp/conditional; fi",
    "false || git clone secret /tmp/branch",
    "git clone secret /tmp/pipeline | true",
    "git clone secret /tmp/redirect >/dev/null",
    "git clone --separate-git-dir /tmp/gitdir secret /tmp/other",
    "git clone https://host/implicit.git",
    "git clone source $unbound/repo",
    'tmp=$(mktemp -d); tmp=something-else; git clone source "$tmp/repo"',
    "tmp=$(mktemp -d); git clone source '$tmp/repo'",
    "git clone source /tmp/" + "x".repeat(257),
    "git clone source small" + " ".repeat(4096),
    "git clone source /tmp/with\x1bcontrol",
  ])
    emit(run, command);
  assert.deepEqual(monitor.snapshot(), []);
});

test("rejects ordinary malformed shell words near the scan limit and still observes later calls", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  const note = "Inspect the files and review any changes. ".repeat(90);
  const bad = `git clone source /tmp/not-observed; printf "Workspace $WORKSPACE: ${note}`;
  assert(bad.length > 3_000 && bad.length < 4_096, "exercise the tokenizer, not the length guard");
  emit(run, bad);
  emit(run, 'pin="$(mktemp -d); git clone source "$pin/repo"');
  emit(run, 'git clone "${SOURCE_URL" /tmp/not-observed');
  const badRedirect = `cd /tmp/not-observed ${">x".repeat(1_950)} >'unfinished`;
  assert(badRedirect.length > 3_000 && badRedirect.length < 4_096);
  emit(run, badRedirect);
  assert.deepEqual(monitor.snapshot(), []);
  emit(run, 'git clone "$SOURCE_URL" /tmp/next');
  assert.deepEqual(monitor.snapshot(), [clone("/tmp/next", false)]);
});

test("never re-admits a duplicate, consumed or end-first Bash ID in the same Run", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  run.observe(start("git clone source ambiguous-first", "duplicate"));
  run.observe(start("echo unrelated", "duplicate"));
  run.observe(end("duplicate"));
  run.observe(start("git clone source ambiguous-reuse", "duplicate"));
  run.observe(end("duplicate"));
  run.observe(end("duplicate"));

  run.observe(start("git clone source original", "consumed"));
  run.observe(end("consumed", { isError: true }));
  run.observe(start("git clone source consumed-reuse", "consumed"));
  run.observe(end("consumed"));

  run.observe(end("end-first"));
  run.observe(start("git clone source end-first-reuse", "end-first"));
  run.observe(end("end-first"));
  emit(run, "git clone source unrelated");
  assert.deepEqual(monitor.snapshot(), [clone("unrelated", true), clone("original", false)]);
});

test("keeps only eight distinct recent observations and fences IDs dropped at the in-flight limit", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  for (let i = 0; i < 16; i++) run.observe(start(`git clone source path-${i}`, `id-${i}`));
  run.observe(start("git clone source omitted", "overflow"));
  assert.deepEqual(monitor.snapshot(), []);
  run.observe(end("id-0")); // Free a slot without observing the overflowed call's end.
  run.observe(start("git clone source overflow-reuse", "overflow"));
  run.observe(end("overflow"));
  run.observe(start("git clone source reuse-after-end", "overflow"));
  run.observe(end("overflow"));
  assert.deepEqual(monitor.snapshot(), [clone("path-0", true)]);
  for (let i = 1; i < 16; i++) run.observe(end(`id-${i}`));
  assert.deepEqual(
    monitor.snapshot().map((row) => row.path),
    [15, 14, 13, 12, 11, 10, 9, 8].map((i) => `path-${i}`),
  );
  emit(run, "git clone source new-after-overflow");
  assert.deepEqual(monitor.snapshot()[0], clone("new-after-overflow", true));
  assert.deepEqual(new WorkspaceMonitor().snapshot(), []);
});

test("bounded merge preserves newer starts and reverse request order within one call", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  run.observe(start("cd /tmp/old", "old"));
  run.observe(start("cd /tmp/overlap; cd /tmp/older-new", "parallel"));
  emit(run, "cd /tmp/overlap; cd /tmp/other; cd /tmp/overlap");
  run.observe(end("parallel"));
  assert.deepEqual(monitor.snapshot(), [
    cd("/tmp/overlap"),
    cd("/tmp/other"),
    cd("/tmp/older-new"),
  ]);
  for (let i = 0; i < 8; i++) emit(run, `cd /tmp/path-${i}`);
  const snapshot = monitor.snapshot();
  run.observe(end("old"));
  assert.strictEqual(monitor.snapshot(), snapshot, "a row below the cap does not rematerialize");
  assert.deepEqual(
    snapshot.map(({ path }) => path),
    [7, 6, 5, 4, 3, 2, 1, 0].map((i) => `/tmp/path-${i}`),
  );
});

test("only standalone clone and worktree hints inspect Bash exit details", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  let reads = 0;
  for (const command of ["cd /tmp/cd", "git -C /tmp/git status", "git clone source /tmp/clone"]) {
    run.observe(start(command, command));
    const done = end(command);
    Object.defineProperty(done, "result", {
      get() {
        reads++;
        return { structuredContent: { exit_code: 0 } };
      },
    });
    run.observe(done);
  }
  assert.equal(reads, 1);
  assert.deepEqual(monitor.snapshot(), [
    clone("/tmp/clone", true),
    { kind: "git -C", path: "/tmp/git", bashExitZero: false },
    cd("/tmp/cd"),
  ]);
});

test("stops watching a Run at the tracked-ID bound instead of forgetting IDs", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  for (let i = 0; i < 254; i++) run.observe(end(`unmatched-${i}`));
  run.observe(start("git clone source pending", "pending"));
  run.observe(start("git clone source retained", "retained")); // The 256th ID fits.
  run.observe(end("retained"));
  assert.deepEqual(monitor.snapshot(), [clone("retained", true)]);
  run.observe(start("git clone source overflow", "distinct-overflow"));
  run.observe(end("pending"));
  run.observe(end("distinct-overflow"));
  run.observe(start("git clone source old-id-reuse", "unmatched-0"));
  run.observe(end("unmatched-0"));
  emit(run, "git clone source after-fence");
  assert.deepEqual(monitor.snapshot(), [clone("retained", true)]);

  const fresh = monitor.watchRun();
  fresh.observe(start("git clone source fresh", "unmatched-0"));
  fresh.observe(end("unmatched-0"));
  assert.deepEqual(monitor.snapshot(), [clone("fresh", true), clone("retained", true)]);
});

test("Reset clears completed and pending Bash hints without sealing the current Run", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  const command = "git clone source /tmp/checkout";
  emit(run, "cd /tmp/earlier");
  run.observe(start(command, "old"));
  run.observe(start("cd /tmp/late", "late"));
  monitor.reset();
  monitor.reset();
  assert.deepEqual(monitor.snapshot(), []);

  run.observe(start(command, "fresh"));
  run.observe(end("fresh", { isError: true }));
  const fresh = monitor.snapshot();
  run.observe(end("old"));
  run.observe(end("late"));
  // An ID-only end must not pair with a new start reusing a pre-Reset or
  // unseen tail ID, and neither can affect the unrelated matched hint.
  run.observe(end("unseen"));
  for (const id of ["old", "unseen"]) {
    run.observe(start("cd /tmp/reused", id));
    run.observe(end(id));
    assert.strictEqual(monitor.snapshot(), fresh);
  }
  assert.deepEqual(fresh, [clone("/tmp/checkout", false)]);

  monitor.reset();
  emit(run, "cd /tmp/next");
  assert.deepEqual(monitor.snapshot(), [cd("/tmp/next")]);
  run.clear();
  monitor.reset();
  emit(run, command);
  assert.deepEqual(monitor.snapshot(), []);
});

test("an unseen Bash end at the Run ID cap does not discard a fresh matched hint after Reset", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  monitor.reset();
  for (let i = 0; i < 255; i++) run.observe(end(`old-${i}`));
  run.observe(start("cd /tmp/fresh", "fresh"));
  run.observe(end("unseen-at-cap"));
  run.observe(end("fresh"));
  assert.deepEqual(monitor.snapshot(), [cd("/tmp/fresh")]);

  monitor.reset();
  run.observe(start("cd /tmp/reused", "unseen-at-cap"));
  run.observe(end("unseen-at-cap"));
  assert.deepEqual(monitor.snapshot(), []);
});

test("clearing a Run watcher discards pending starts and ignores all later events", () => {
  const monitor = new WorkspaceMonitor();
  const run = monitor.watchRun();
  run.observe(start("git clone source old-run", "reusable"));
  run.clear();
  run.observe(end("reusable"));
  emit(run, "git clone source after-clear");
  assert.deepEqual(monitor.snapshot(), []);

  const fresh = monitor.watchRun();
  fresh.observe(start("git clone source new-run", "reusable"));
  fresh.observe(end("reusable"));
  assert.deepEqual(monitor.snapshot(), [clone("new-run", true)]);
});

test("reuses the SDK Run subscription and exposes quiet observations only to Info", async () => {
  const monitor = new WorkspaceMonitor();
  const activity = new ChildActivity("/admitted-cwd", undefined, monitor);
  const observed = [];
  const gate = new ChildRunGate();
  const callbacks = {
    turnStart() {},
    turnEnd() {},
    outputDelta() {},
    output() {},
    inputEntered() {},
  };
  let emitEvent,
    subscriptions = 0,
    removals = 0;
  const session = {
    sessionId: "synthetic-child",
    isIdle: true,
    isStreaming: false,
    clearQueue: () => ({ steering: [], followUp: [] }),
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    async waitForIdle() {
      assert.equal(gate.accepting, false);
      // A known completion during drain still contributes, but a new start
      // after the Run's gate closed cannot create a hint.
      emitEvent(start("cd /tmp/outside-gate", "closed"));
      emitEvent(end("closed"));
      emitEvent(end("during-drain"));
    },
    subscribe(listener) {
      subscriptions++;
      emitEvent = listener;
      return () => removals++;
    },
    async prompt() {
      emitEvent(start("cd /not-bash", "read", "read"));
      emitEvent(end("read", { toolName: "read" }));
      emitEvent(start('tmp=$(mktemp -d); git clone source "$tmp/repo" && cd "$tmp/repo"'));
      emitEvent(end());
      emitEvent(start("git clone source /tmp/finished", "finished"));
      emitEvent(end("finished"));
      emitEvent(start("git clone source /tmp/late", "late"));
      emitEvent(start("cd /tmp/draining", "during-drain"));
      emitEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          provider: "synthetic",
          model: "synthetic",
        },
      });
    },
  };
  const port = new PiAgentSessionAdapter({
    session,
    parentBus: {
      emit() {
        assert.fail("workspace must not emit bus events");
      },
    },
    gate,
    readiness() {},
    workspaceMonitor: {
      watchRun() {
        const workspace = monitor.watchRun();
        return {
          observe(event) {
            observed.push(event.toolCallId);
            workspace.observe(event);
          },
          clear: workspace.clear,
        };
      },
    },
  });
  assert.equal((await port.run("synthetic", callbacks)).kind, "success");
  assert.equal(subscriptions, 1);
  assert.equal(removals, 1);
  emitEvent(end("late"));
  assert.deepEqual(observed, [
    "call",
    "call",
    "finished",
    "finished",
    "late",
    "during-drain",
    "closed",
    "during-drain",
  ]);
  assert.deepEqual(activity.workspaceSnapshot(), [
    cd("/tmp/draining"),
    clone("/tmp/finished", true),
    { kind: "temporary clone" },
  ]);
  assert.equal(Object.hasOwn(activity.snapshot(), "workspace"), false);

  let reads = 0;
  const input = {
    view: {
      run_id: "synthetic",
      agent_id: "agent",
      status: "completed",
      phase: "settled",
      execution_exited: true,
      turns: 1,
      max_turns: 5,
      elapsed_ms: 100,
      pending_messages: 0,
      cleanup_errors: [],
      discarded_inputs: [],
      effective_settings: {
        cwd: "/admitted-cwd",
        profile: "editor",
        tools: ["bash"],
        model: "synthetic",
        preset: "fixture",
        strength: "d1",
        thinking: "off",
      },
    },
    live: activity.snapshot(),
    workspaceSnapshot: () => {
      reads++;
      return activity.workspaceSnapshot();
    },
  };
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  renderDetailSummary(input, theme, 80);
  assert.equal(reads, 0);
  const info = renderDetailInfo(input, theme, 100).join("\n");
  assert.equal(reads, 1);
  assert.match(info, /cwd\s+\/admitted-cwd/);
  assert.match(info, /Recent Bash references · paths not verified/);
  assert.match(info, /clone · Bash reported exit 0 · \/tmp\/finished/);
  assert.match(info, /temporary clone referenced \(path unresolved\)/);
  assert.doesNotMatch(info, /success|\$tmp|\/tmp\/late|outside-gate|output not retained/);
});
