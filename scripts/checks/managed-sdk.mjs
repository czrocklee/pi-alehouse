// Managed SDK session checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
export async function runManagedSdk(
  piRoot,
  load,
  scratch,
  management,
  childDenies,
  agentDir,
  publicServicePath,
  cwd,
  publicService,
  sessions,
  externalScratch,
  require,
  configPath,
  repo,
  gitRequested,
  check,
  positive,
  fixedRequested,
  weeklyRequested,
  localCd,
  outsideCd,
  cdBase,
) {
  // Actual generated portable wrapper + root/child permissions service and
  // normal forwarding. The named model-authorizer spy counts entry to the
  // real ask chain; static positives must never reach it or a UI at all.
  const {
    createAgentSession,
    createEventBus,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
  } = await import(join(piRoot, "dist/index.js"));
  const { loadExtensions } = await import(join(piRoot, "dist/core/extensions/loader.js"));
  const { AuthStorage } = await import(join(piRoot, "dist/core/auth-storage.js"));
  const runtime = await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let uiCalls = 0,
    modelCalls = 0,
    grantWhole = false;
  const errors = [];
  const { getPermissionsService } = await load("service");
  // Registry-only probes, never executable Harness tools or runtime aliases.
  // The SDK rejects unknown names before permissions; registering even retired
  // names here proves their explicit deny, not merely that they are absent.
  const communicationProbe = join(scratch, "communication-permission-probe.ts");
  writeFileSync(
    communicationProbe,
    `export default function (pi) {
    for (const name of ${JSON.stringify([...new Set([...management, ...childDenies, "alert_parent", "ask_parent"])])})
      pi.registerTool({ name, label: name, description: "Offline permission registry probe; never execute",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        execute() { throw new Error("Permission probe must not execute"); } });
  }`,
  );
  const make = async (agent, parent, duplicate, suppliedSessionManager, guardFirst = false) => {
    const eventBus = createEventBus();
    const settingsManager = SettingsManager.inMemory();
    const extensions = (
      guardFirst
        ? ["static-safety-guard.ts", "managed-permissions/index.ts", "policy-grep.ts"]
        : ["managed-permissions/index.ts", "static-safety-guard.ts", "policy-grep.ts"]
    ).map((name) => join(agentDir, "extensions", name));
    extensions.push(communicationProbe);
    const unpatched = join(dirname(publicServicePath), "index.ts");
    if (duplicate === "before") extensions.unshift(unpatched);
    if (duplicate === "after") extensions.push(unpatched);
    const loaded = await loadExtensions(extensions, cwd, eventBus);
    assert.deepEqual(loaded.errors, [], "Actual managed extension loads");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus,
      extensionsOverride: () => loaded,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const sm = suppliedSessionManager ?? SessionManager.inMemory(cwd);
    if (agent) sm.appendCustomEntry("active_agent", { name: agent });
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: sm,
      modelRuntime: runtime,
    });
    const id = sm.getSessionId();
    if (parent)
      parent.eventBus.emit("subagents:child:session-created", {
        sessionId: id,
        parentSessionId: parent.id,
      });
    const ui = {
      setStatus() {},
      notify() {},
      setWidget() {},
      setTitle() {},
      select: async (_title, choices) => {
        uiCalls++;
        if (!grantWhole) return undefined;
        return choices[1]; // session grant, then whole-session scope
      },
      input: async () => undefined,
      confirm: async () => false,
    };
    await session.bindExtensions({
      mode: "rpc",
      ...(parent ? {} : { uiContext: ui }),
      onError: (error) => errors.push(error),
    });
    const service = getPermissionsService(id);
    assert(service, `Managed service: ${agent}; errors=${JSON.stringify(errors)}`);
    assert.equal(
      publicService.getPermissionsService(id),
      service,
      "Unpatched public service import reaches the managed authority through shared symbols",
    );
    if (!parent)
      service.registerAuthorizer("auto-model-judge", async () => {
        modelCalls++;
        return { kind: "defer" };
      });
    // Pi 1.2 takes the starting trigger, then BuildSystemPromptOptions; `cwd` is
    // required and the active-agent tag must land inside the rendered prompt,
    // because the permission system reads it back out of that text.
    await session.extensionRunner.emitBeforeAgentStart(
      { messageType: "user", prompt: "Fixture inspection" },
      { cwd, ...(agent ? { appendSystemPrompt: `<active_agent name="${agent}"/>` } : {}) },
    );
    const record = {
      session,
      id,
      eventBus,
      parent,
      call: (toolName, input) =>
        session.extensionRunner.emitToolCall({
          type: "tool_call",
          toolCallId: `actual-${Math.random()}`,
          toolName,
          input,
        }),
      callAs: (toolCallId, toolName, input) =>
        session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId, toolName, input }),
      result: (event) => session.extensionRunner.emitToolResult({ type: "tool_result", ...event }),
    };
    sessions.push(record);
    return record;
  };
  const root = await make();
  // Home Manager's SOPS symlink and its real runtime generations are explicit
  // path denies, not merely external-directory asks. Only fake data is created.
  const fakeSecrets = join(scratch, ".config/sops-nix/secrets");
  mkdirSync(fakeSecrets, { recursive: true });
  writeFileSync(join(fakeSecrets, "token"), "SYNTHETIC_ONLY\n");
  writeFileSync(join(cwd, "secrets.yaml"), "ENC[synthetic fixture]\n");
  symlinkSync(join(fakeSecrets, "token"), join(cwd, "runtime-secret-alias.txt"));
  const runtimeSecrets = [
    "~/.config/sops-nix/secrets",
    "~/.config/sops-nix/secrets/token",
    "runtime-secret-alias.txt",
    "/run/secrets",
    "/run/secrets/__pi_fixture_only__/token",
    "/run/secrets/__pi_fixture_only__/.env.example",
    "/run/secrets.d",
    "/run/secrets.d/__pi_fixture_only__/token",
    "/run/user/12345678/secrets",
    "/run/user/12345678/secrets/token",
    "/run/user/12345678/secrets.d",
    "/run/user/12345678/secrets.d/1/token",
  ];
  const nativeReads = [
    "git diff",
    "git diff --stat",
    "git diff --check",
    "git diff --cached --name-only",
    "git diff -- src",
    "git diff -- .",
    "git diff HEAD -- ordinary.txt",
    "git status --short && git diff --stat && git log -5 --oneline",
    "git --no-pager diff -- ordinary.txt | head -20",
    "git -C . diff --check",
    "cd . && git diff --stat | tail -5",
    "git diff -- ordinary.txt | sed -n '1,20p'",
    "git log --oneline HEAD~1..HEAD",
    "nl -ba ordinary.txt | sed -n '1,20p'",
    "env git log --format='%H %P %s' HEAD~1..HEAD",
    "env git log --oneline -- ordinary.txt",
    "env git show HEAD:ordinary.txt",
    "git diff HEAD~1 HEAD -- ordinary.txt",
    "git diff HEAD...main",
    "git rev-parse --verify main",
    "git branch -vv && git remote",
    "git diff --no-renames --name-only --diff-filter=U",
    "git diff --no-renames --cached --diff-filter=R --name-status",
    "echo 'fixture' && git diff --check",
    "git status --short && cat ordinary.txt",
    "git diff --stat; git status --short; cat ordinary.txt",
  ];
  for (const agent of [undefined, "editor"]) {
    const node = agent ? await make(agent, root) : root;
    for (const tool of ["alert_parent", "ask_parent"]) {
      const decision = await node.call(
        tool,
        tool === "alert_parent" ? { message: "synthetic" } : { question: "synthetic" },
      );
      assert.equal(
        decision?.block,
        undefined,
        `Actual communication gate: ${agent}: ${tool}: ${JSON.stringify(decision)}`,
      );
    }
    assert.equal(
      (await node.call("notify_parent", { message: "retired" }))?.block,
      true,
      "Retired communication cannot reach execute",
    );
    for (const tool of agent ? childDenies : management) {
      assert.equal(
        (await node.call(tool, {}))?.block,
        agent ? true : undefined,
        `Actual management exclusion: ${agent}: ${tool}`,
      );
    }
    // Non-Git static positives retain zero-review assertions. Git forms are
    // checked separately below through the real SDK's ordinary ask/yolo lane.
    for (const command of [
      ...positive,
      ...fixedRequested,
      ...weeklyRequested,
      ...nativeReads,
    ].filter((command) => !command.includes("git "))) {
      assert.equal(
        (await node.call("bash", { command }))?.block,
        undefined,
        `Actual gate allows ${agent}: ${command}`,
      );
    }
    assert.equal((await node.call("read", { path: "ordinary.txt" }))?.block, undefined);
    assert.equal(
      (await node.call("read", { path: "secrets.yaml" }))?.block,
      undefined,
      "Encrypted repository files are not runtime secrets",
    );
    assert.equal((await node.call("read", { path: "/proc/meminfo" }))?.block, undefined);
    assert.equal((await node.call("read", { path: "/proc/self/mountinfo" }))?.block, undefined);
    for (const path of runtimeSecrets) {
      assert.equal((await node.call("read", { path }))?.block, true, `SOPS read: ${agent} ${path}`);
      assert.equal(
        (await node.call("write", { path, content: "fixture" }))?.block,
        true,
        `SOPS write: ${agent} ${path}`,
      );
      assert.equal(
        (await node.call("bash", { command: `cat ${path}` }))?.block,
        true,
        `SOPS Bash: ${agent} ${path}`,
      );
    }
    for (const tool of ["edit", "write"]) {
      assert.equal(
        (await node.call(tool, { path: "src/new-file.ts", content: "fixture", edits: [] }))?.block,
        undefined,
        "Editing profile inherits project path scope",
      );
      assert.equal(
        (
          await node.call(tool, {
            path: join(scratch, "unregistered-tmp.txt"),
            content: "fixture",
            edits: [],
          })
        )?.block,
        undefined,
        "Direct editing inherits existing /tmp scope",
      );
      for (const path of [".env", ".git/config", "~/.pi/agent/settings.json", "alias.txt"])
        assert.equal(
          (await node.call(tool, { path, content: "fixture", edits: [] }))?.block,
          true,
          `Protected write: ${agent} ${path}`,
        );
    }
    assert.equal(
      (await node.call("read", { path: ".env" }))?.block,
      true,
      "Actual secret read denial",
    );
    assert.equal(
      (await node.call("bash", { command: "cut -f 1 .env" }))?.block,
      true,
      "Actual Bash secret denial",
    );
    assert.equal(
      (await node.call("bash", { command: "sudo true" }))?.block,
      true,
      "Actual privilege denial",
    );
    assert.equal(uiCalls, 0, "Static normal operations never prompt UI");
    assert.equal(modelCalls, 0, "Static normal operations never enter a model authorizer");
  }
  // Exercise actual agent-core argument validation, preflight and execution
  // dispatch, with a recording Bash implementation and an in-memory response.
  // No provider/model API and no historical/shell command is executed here.
  const { runAgentLoop } = await import(
    join(
      dirname(require.resolve("@earendil-works/pi-agent-core/package.json")),
      "dist/agent-loop.js",
    )
  );
  const executed = [];
  let providerCalls = 0,
    finishedTurns = 0;
  const bashTool = root.session.agent.state.tools.find((tool) => tool.name === "bash");
  const readTool = root.session.agent.state.tools.find((tool) => tool.name === "read");
  const assistant = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "native-read",
        name: "bash",
        arguments: { command: "git status --short" },
      },
      ...[
        ...fixedRequested,
        ...weeklyRequested.filter((command) => !command.startsWith("git ")),
      ].map((command, index) => ({
        type: "toolCall",
        id: `fixed-${index}`,
        name: "bash",
        arguments: { command },
      })),
      { type: "toolCall", id: "secret-read", name: "bash", arguments: { command: "cat .env" } },
      { type: "toolCall", id: "proc-meminfo", name: "read", arguments: { path: "/proc/meminfo" } },
      {
        type: "toolCall",
        id: "proc-mountinfo",
        name: "read",
        arguments: { path: "/proc/self/mountinfo" },
      },
    ],
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
  await runAgentLoop(
    [{ role: "user", content: "Fixture", timestamp: Date.now() }],
    {
      systemPrompt: "Fixture",
      messages: [],
      tools: [
        {
          ...bashTool,
          execute: async (_id, args) => {
            executed.push({ tool: "bash", input: structuredClone(args) });
            return { content: [{ type: "text", text: "recorded" }] };
          },
        },
        {
          ...readTool,
          execute: async (_id, args) => {
            executed.push({ tool: "read", input: structuredClone(args) });
            return { content: [{ type: "text", text: "recorded" }], details: undefined };
          },
        },
      ],
    },
    {
      model: { provider: "fixture", id: "fixture" },
      convertToLlm: (messages) => messages,
      beforeToolCall: ({ toolCall, args }) => root.call(toolCall.name, args),
      finishTurn: () => {
        finishedTurns++;
        return { action: "end" };
      },
    },
    async () => {},
    undefined,
    () => {
      assert.equal(
        ++providerCalls,
        1,
        "finishTurn must end after the fixture tool batch, not request another response",
      );
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done" };
        },
        result: async () => assistant,
      };
    },
  );
  assert.equal(providerCalls, 1);
  assert.equal(finishedTurns, 1);
  assert.equal(
    executed.length,
    1 +
      fixedRequested.length +
      weeklyRequested.filter((command) => !command.startsWith("git ")).length +
      2,
    "Denied Bash/read calls never reach execute",
  );
  const executedBash = executed
    .filter((item) => item.tool === "bash")
    .map((item) => item.input.command);
  const executedRead = executed
    .filter((item) => item.tool === "read")
    .map((item) => item.input.path)
    .sort();
  const gitExecution = executedBash.find((command) => command.startsWith("git "));
  assert.equal(
    gitExecution,
    "git status --short",
    "An explicit configured Git allowance executes the original argv, not a managed grant",
  );
  assert.equal(
    executedBash.some((command) => command.startsWith("git diff")),
    false,
    "Diff is no longer an automatic-read dispatch fixture",
  );
  assert.equal(
    executedBash.some(
      (command) => command.includes("--no-lazy-fetch") || command.includes("--no-replace-objects"),
    ),
    false,
  );
  assert(executedBash.includes("type -P -- pi"));
  assert(executedBash.includes("bash --noprofile --norc -p -n -- syntax.sh"));
  assert(executedBash.includes("printenv -- PI_MODEL PI_MODEL_ID PI_PROVIDER"));
  assert(executedBash.includes("printenv -- BUILD_DIR AOBUS_BUILD_ROOT"));
  assert(executedBash.includes("sed -n '1p;2,4p' ordinary.txt"), "Sed executes unchanged");
  assert.deepEqual(executedRead, ["/proc/meminfo", "/proc/self/mountinfo"]);
  assert.equal(uiCalls, 0);
  assert.equal(modelCalls, 0);
  console.log(
    "PASS: real agent-core dispatch executes only SDK-preflighted hardened fixed queries and exact proc reads; no model API",
  );

  // Keep a second cooperative child to exercise sibling forwarding explicitly.
  await make("editor", root);
  // Start with a child's ask, approve explicitly for the whole task tree, then
  // siblings and a steering event reuse the upstream grant without new prompts.
  grantWhole = true;
  const first = sessions[1];
  assert.equal((await first.call("bash", { command: "sleep 7" }))?.block, undefined);
  assert.equal(uiCalls, 2, "Exactly decision + whole-session scope selectors");
  const approvedModelCalls = modelCalls;
  for (const node of sessions) {
    await node.session.extensionRunner.emitInput(
      "Continue the same authorized fixture task",
      undefined,
      "interactive",
      "steer",
    );
    assert.equal(
      (await node.call("bash", { command: "sleep 7" }))?.block,
      undefined,
      "Sibling/steer reuses explicit grant",
    );
  }
  assert.equal(uiCalls, 2);
  assert.equal(modelCalls, approvedModelCalls);
  grantWhole = false;
  for (const command of [
    "printenv HOME",
    "printenv",
    "ruff check syntax.sh",
    "ruff format --check syntax.sh",
  ]) {
    const before = uiCalls;
    assert.equal(
      (await root.call("bash", { command }))?.block,
      true,
      `Deferred query remains review: ${command}`,
    );
    assert.equal(uiCalls, before + 1, `Deferred query is an ask, not a new deny: ${command}`);
  }
  assert.equal(
    (await first.call("bash", { command: "ruff check --fix syntax.sh" }))?.block,
    true,
    "Unapproved Ruff writes still require review",
  );
  for (const path of [
    "/proc/1/environ",
    "/proc/self/environ",
    "/proc/self/fd",
    `/proc/${process.pid}/mountinfo`,
  ])
    assert.equal(
      (await root.call("read", { path }))?.block,
      true,
      `Actual SDK retains review for ${path}`,
    );
  for (const command of [
    "cat .env",
    "echo fixture > ~/.pi/agent/settings.json",
    "git diff --stat --output=ordinary.txt",
    "git -c core.pager=cat status --short",
    "PATH=./fixture-bin git status --short",
    "readlink $INPUT",
    "git show HEAD:.env",
    "git status --short && touch ordinary.txt",
    "git remote -v",
    "git diff -- 'ordinary.txt '",
    "sed -n '1p; e touch ordinary.txt' ordinary.txt",
    "sed -i 's/a/b/' ordinary.txt",
    "cd missing || git diff",
    "cd missing; git diff",
    "cd . | git diff",
    "cd - && git status --short",
    "cd -- && git status --short",
    "df --sync .",
    "free --unknown",
  ]) {
    assert.equal(
      (await root.call("bash", { command }))?.block,
      true,
      `Actual gate blocks/asks ${command}`,
    );
  }
  for (const node of sessions.slice(1)) {
    assert.equal(
      (await node.call("bash", { command: "echo fixture > ordinary.txt" }))?.block,
      undefined,
      "Editing children inherit ordinary path scope",
    );
    assert.equal(
      (await node.call("write", { path: "/var/lib/pi-fixture/external.txt", content: "fixture" }))
        ?.block,
      true,
      "Editing capability cannot authorize external writes",
    );
    assert.equal(
      (await node.call("read", { path: "/var/lib/pi-fixture/external.txt" }))?.block,
      true,
      "Actual external scope still requires approval",
    );
  }
  assert.deepEqual(errors, [], "Actual SDK lifecycle has no extension errors");
  console.log(
    "PASS: actual portable wrapper + SDK root/editor child gates; zero UI/model entries for proven reads; upstream explicit whole-session grant survives siblings and steer",
  );

  // The remaining read-only profile has no Bash/edit/write capability. Verify
  // its actual service without feeding it the editor's Bash-positive matrix.
  const researcher = await make("researcher", root);
  for (const tool of childDenies)
    assert.equal(
      (await researcher.call(tool, {}))?.block,
      true,
      `Researcher child exclusion: ${tool}`,
    );
  for (const tool of ["alert_parent", "ask_parent"]) {
    assert.equal(
      (
        await researcher.call(
          tool,
          tool === "alert_parent" ? { message: "synthetic" } : { question: "synthetic" },
        )
      )?.block,
      undefined,
    );
  }
  assert.equal((await researcher.call("read", { path: "ordinary.txt" }))?.block, undefined);
  assert.equal((await researcher.call("read", { path: ".env" }))?.block, true);
  for (const tool of ["edit", "write"]) {
    assert.equal(
      (await researcher.call(tool, { path: "src/new-file.ts", content: "fixture", edits: [] }))
        ?.block,
      true,
      `Researcher editing denial: ${tool}`,
    );
  }
  assert.equal(
    (await researcher.call("bash", { command: "git status --short" }))?.block,
    true,
    "Researcher raw Bash deny survives the fixture's exact Git allow",
  );

  const observeMktemp = async (node, label, directory = "/tmp") => {
    // This existing proof lane deliberately accepts only /tmp/tmp.*. Keep the
    // exact observed call/result and its actual execution environment aligned;
    // the collector's nested TMPDIR is for other disposable fixture state.
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = directory;
    try {
      const input = { command: "mktemp -d" };
      const toolCallId = `mktemp-${label}`;
      assert.equal((await node.callAs(toolCallId, "bash", input))?.block, undefined);
      const output = execFileSync("mktemp", ["-d"], { encoding: "utf8" });
      externalScratch.push(output.trim());
      await node.result({
        toolCallId,
        toolName: "bash",
        input,
        content: [{ type: "text", text: output }],
        details: undefined,
        isError: false,
      });
      return output.trim();
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  };

  // Observing a real mktemp result from a nonstandard TMPDIR must NOT widen
  // the production lane. Its unproven mkdir still reaches ordinary approval.
  const nonstandardBase = mkdtempSync(join(tmpdir(), "pi-nonstandard-scratch-"));
  externalScratch.push(nonstandardBase);
  const nonstandardRoot = await observeMktemp(root, "nonstandard-directory", nonstandardBase);
  assert.equal(dirname(nonstandardRoot), nonstandardBase);
  const nonstandardInput = { command: `mkdir -p ${nonstandardRoot}/unproven` };
  assert.equal(
    (await root.callAs("file-effects-nonstandard-directory", "bash", nonstandardInput))?.block,
    true,
  );
  assert.equal(
    nonstandardInput.command,
    `mkdir -p ${nonstandardRoot}/unproven`,
    "nonstandard scratch never receives a rewrite proof",
  );

  // A root exists only after the SDK's exact mktemp call/result pair. The
  // resulting mkdir/cp program is hardened in-place, then all ordinary Bash,
  // READ, WRITE and external-directory gates still run.
  const liveRoot = await observeMktemp(root, "current");
  writeFileSync(join(cwd, "copy-a.txt"), "alpha\n");
  writeFileSync(join(cwd, "copy-b.txt"), "beta\n");
  const fileUiBefore = uiCalls;
  const fileInput = {
    command: `mkdir -p ${liveRoot}/out && cp copy-a.txt copy-b.txt ${liveRoot}/out`,
  };
  assert.equal((await root.callAs("file-effects-current", "bash", fileInput))?.block, undefined);
  assert.match(
    fileInput.command,
    /^mkdir -p -- \/tmp\/tmp\.[A-Za-z0-9]+\/out && cp --no-dereference --target-directory=/,
  );
  assert(
    fileInput.command.includes(
      `${liveRoot}/out -- ${join(cwd, "copy-a.txt")} ${join(cwd, "copy-b.txt")}`,
    ),
  );
  assert.equal(uiCalls, fileUiBefore, "Observed scratch mkdir/cp must require zero UI");
  const executedFiles = spawnSync("bash", ["-c", fileInput.command], { cwd, encoding: "utf8" });
  assert.equal(executedFiles.status, 0, executedFiles.stderr);
  assert.equal(readFileSync(join(liveRoot, "out/copy-a.txt"), "utf8"), "alpha\n");
  assert.equal(readFileSync(join(liveRoot, "out/copy-b.txt"), "utf8"), "beta\n");
  assert.equal(
    (await root.callAs("file-effects-reused-input", "bash", fileInput))?.block,
    true,
    "A reused input object cannot retain a stale no-overwrite proof",
  );
  const freshInput = { command: `mkdir -p ${liveRoot}/cross-session` };
  assert.equal(
    (await root.callAs("file-effects-fresh-input", "bash", freshInput))?.block,
    undefined,
  );
  const stranger = await make();
  assert.equal(
    (await stranger.callAs("file-effects-cross-session-input", "bash", freshInput))?.block,
    true,
    "Input identity alone cannot carry a proof to another session",
  );

  // Both real hook orders must accept a proven leading cd, not merely block
  // it first on another path rule. Execute only these fabricated scratch plans.
  writeFileSync(join(localCd, "cd-copy.txt"), "checked local source\n");
  writeFileSync(join(outsideCd, "cd-copy.txt"), "wrong CDPATH source\n");
  for (const guardFirst of [false, true]) {
    for (const agent of [undefined, "editor"]) {
      const node = await make(agent, agent ? root : undefined, undefined, undefined, guardFirst);
      const target = await observeMktemp(node, `cd-${agent ?? "root"}-${guardFirst}`);
      const input = {
        command: `cd nested && mkdir -p ${target}/out && cp cd-copy.txt ${target}/out/copied.txt`,
      };
      const before = { ui: uiCalls, model: modelCalls };
      assert.equal(
        (await node.call("bash", input))?.block,
        undefined,
        `Positive scratch cd: guardFirst=${guardFirst}, agent=${agent}`,
      );
      assert(
        input.command.startsWith(`cd ${localCd} && `),
        "Absolute cd needs no option delimiter",
      );
      assert.deepEqual(
        { ui: uiCalls, model: modelCalls },
        before,
        "Leading cd must not enter approval",
      );
      const execution = spawnSync("bash", ["-c", input.command], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CDPATH: cdBase },
      });
      assert.equal(execution.status, 0, execution.stderr);
      assert.equal(readFileSync(join(target, "out/copied.txt"), "utf8"), "checked local source\n");
    }
  }
  console.log(
    "PASS: positive scratch cd under both extension orders, root/editing worker, and actual CDPATH-safe execution",
  );

  const secretCopy = { command: `cp .env ${liveRoot}/secret-copy` };
  assert.equal(
    (await root.callAs("file-effects-secret", "bash", secretCopy))?.block,
    true,
    "Sensitive source still reaches READ deny",
  );
  assert.match(
    secretCopy.command,
    /^cp --no-dereference --no-target-directory -- /,
    "Sensitive source was analyzed, not skipped",
  );

  symlinkSync("copy-a.txt", join(cwd, "copy-link.txt"));
  writeFileSync(join(cwd, "hard-a.txt"), "hard\n");
  linkSync(join(cwd, "hard-a.txt"), join(cwd, "hard-b.txt"));
  execFileSync("mkfifo", [join(cwd, "copy.fifo")]);
  for (const [label, source] of [
    ["symlink", "copy-link.txt"],
    ["hardlink", "hard-a.txt"],
    ["fifo", "copy.fifo"],
  ]) {
    const input = { command: `cp ${source} ${liveRoot}/${label}` };
    assert.equal((await root.callAs(`file-effects-${label}`, "bash", input))?.block, true);
    assert.equal(
      input.command,
      `cp ${source} ${liveRoot}/${label}`,
      `${label} source must not receive proof`,
    );
  }
  writeFileSync(join(cwd, "copy-a.txt "), "space-suffixed fixture\n");
  const unsupported = [
    `cp 'copy-a.txt ' ${liveRoot}/trimmed`,
    `cp 'file:/../copy-a.txt' ${liveRoot}/uri-alias`,
    `mkdir -p '${liveRoot}/space /'`,
    `cp copy-a.txt/ ${liveRoot}/source-slash`,
    `cp copy-a.txt ${liveRoot}/destination-slash/`,
    `cp copy-a.txt/. ${liveRoot}/source-dot`,
    `mkdir -p ${liveRoot}//repeated`,
    `mkdir ${liveRoot}/plain`,
    `mkdir -p ${liveRoot}/x; cp copy-a.txt ${liveRoot}/x/a`,
    `cp -f copy-a.txt ${liveRoot}/forced`,
    `cp copy-a.txt ${liveRoot}/redirected > ${liveRoot}/log`,
    `mv copy-a.txt ${liveRoot}/moved`,
    `chmod 700 ${liveRoot}`,
  ];
  for (const [index, command] of unsupported.entries()) {
    const input = { command };
    assert.equal(
      (await root.callAs(`file-effects-unsupported-${index}`, "bash", input))?.block,
      true,
    );
    assert.equal(
      input.command,
      command,
      `Unsupported syntax cannot acquire file-effect proof: ${command}`,
    );
  }

  const fakeMessageSession = SessionManager.inMemory(cwd);
  fakeMessageSession.appendCustomMessageEntry(
    "managed-scratch-created",
    JSON.stringify({ path: liveRoot }),
    false,
  );
  const unproven = await make(undefined, undefined, undefined, fakeMessageSession);
  const forged = {
    command: `mkdir -p ${liveRoot}/forged`,
    newScope: { command: `mkdir -p ${liveRoot}/forged` },
  };
  assert.equal((await unproven.callAs("file-effects-forged", "bash", forged))?.block, true);
  assert.equal(forged.command, `mkdir -p ${liveRoot}/forged`, "Model-supplied newScope is inert");
  const messageForgery = { command: `mkdir -p ${liveRoot}/message-forged` };
  assert.equal(
    (await unproven.callAs("file-effects-message", "bash", messageForgery))?.block,
    true,
  );
  assert.equal(messageForgery.command, `mkdir -p ${liveRoot}/message-forged`);

  // Persisted parent inheritance is accepted only under the standard,
  // owner-controlled sessions tree and after the real resolver denies writes.
  // Pi normally creates session subdirectories as 0755: confidentiality comes
  // from the private ancestors; authenticity requires no other-writer bits.
  const standardSessions = join(scratch, ".pi/agent/sessions");
  for (const path of [
    join(scratch, ".pi"),
    join(scratch, ".pi/agent"),
    standardSessions,
    join(standardSessions, "fixture"),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  chmodSync(standardSessions, 0o755);
  chmodSync(join(standardSessions, "fixture"), 0o755);
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const parentStem = join(standardSessions, "fixture", `2026-01-01T00-00-00_${parentId}`);
  const parentFile = `${parentStem}.jsonl`;
  writeFileSync(
    parentFile,
    `${JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: new Date().toISOString(), cwd })}\n`,
    { mode: 0o600 },
  );
  const persistedParent = await make(
    undefined,
    undefined,
    undefined,
    SessionManager.open(parentFile),
  );
  const inheritedRoot = await observeMktemp(persistedParent, "parent");
  // Real parent journals exceed 2 MiB. Read bounded complete records even while
  // an unrelated last record is being appended; never consume a partial record.
  const completeParentJournal =
    readFileSync(parentFile, "utf8") +
    JSON.stringify({ type: "fixture-padding", data: "x".repeat(3 * 1024 * 1024) }) +
    "\n";
  writeFileSync(parentFile, completeParentJournal + '{"in-flight":');
  mkdirSync(join(parentStem, "tasks"), { recursive: true, mode: 0o755 });
  chmodSync(parentStem, 0o755);
  chmodSync(join(parentStem, "tasks"), 0o755);
  const childFile = join(parentStem, "tasks", `${childId}.jsonl`);
  writeFileSync(
    childFile,
    `${JSON.stringify({ type: "session", version: 3, id: childId, parentSession: parentId, timestamp: new Date().toISOString(), cwd })}\n`,
    { mode: 0o600 },
  );
  const persistedChild = await make(
    "editor",
    persistedParent,
    undefined,
    SessionManager.open(childFile),
  );
  const inheritedInput = {
    command: `mkdir -p ${inheritedRoot}/child && cp copy-a.txt ${inheritedRoot}/child/a.txt`,
  };
  const inheritedUiBefore = uiCalls;
  assert.equal(
    (await persistedChild.callAs("file-effects-child", "bash", inheritedInput))?.block,
    undefined,
    "Exact protected parent journal is reusable",
  );
  assert.match(
    inheritedInput.command,
    /^mkdir -p -- .* && cp --no-dereference --no-target-directory -- /,
  );
  assert.equal(uiCalls, inheritedUiBefore);
  writeFileSync(parentFile, completeParentJournal);
  const laterRoot = await observeMktemp(persistedParent, "parent-after-child-start");
  assert.equal(
    (await persistedChild.call("bash", { command: `mkdir -p ${laterRoot}/before-steer` }))?.block,
    true,
    "Unobserved later parent metadata is not guessed",
  );
  await persistedChild.session.extensionRunner.emitInput(
    "Continue with the parent's newly created scratch",
    undefined,
    "interactive",
    "steer",
  );
  assert.equal(
    (await persistedChild.call("bash", { command: `mkdir -p ${laterRoot}/after-steer` }))?.block,
    undefined,
    "Steer can refresh authenticated parent creation records",
  );

  const unrelatedId = "33333333-3333-4333-8333-333333333333";
  const unrelatedFile = join(
    standardSessions,
    "fixture",
    `2026-01-01T00-00-01_${unrelatedId}.jsonl`,
  );
  writeFileSync(
    unrelatedFile,
    `${JSON.stringify({ type: "session", version: 3, id: unrelatedId, timestamp: new Date().toISOString(), cwd })}\n`,
    { mode: 0o600 },
  );
  const unrelated = await make(undefined, undefined, undefined, SessionManager.open(unrelatedFile));
  const crossSession = { command: `mkdir -p ${inheritedRoot}/unrelated` };
  assert.equal(
    (await unrelated.callAs("file-effects-unrelated", "bash", crossSession))?.block,
    true,
  );
  assert.equal(
    crossSession.command,
    `mkdir -p ${inheritedRoot}/unrelated`,
    "Unrelated session cannot claim another root",
  );

  const creationEntry = readFileSync(parentFile, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((entry) => entry.type === "custom" && entry.customType === "managed-scratch-created");
  assert(creationEntry, "Parent fixture contains an actual SDK-created provenance record");
  for (const [label, id] of [
    ["unprotected", "44444444-4444-4444-8444-444444444444"],
    ["alias", "55555555-5555-4555-8555-555555555555"],
  ]) {
    const fakeEntry = { ...creationEntry, data: { ...creationEntry.data, sessionId: id } };
    const journal = `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n${JSON.stringify(fakeEntry)}\n`;
    const target =
      label === "alias"
        ? join(standardSessions, "fixture", `${id}.jsonl`)
        : join(scratch, `${id}.jsonl`);
    writeFileSync(target, journal, { mode: 0o600 });
    let openPath = target;
    if (label === "alias") {
      const alias = join(scratch, "session-directory-alias");
      symlinkSync(dirname(target), alias, "dir");
      openPath = join(alias, basename(target));
    }
    const fake = await make(undefined, undefined, undefined, SessionManager.open(openPath));
    const input = { command: `mkdir -p ${inheritedRoot}/${label}-claim` };
    assert.equal(
      (await fake.callAs(`file-effects-${label}-journal`, "bash", input))?.block,
      true,
      `${label} journal cannot authenticate restored provenance`,
    );
    assert.equal(input.command, `mkdir -p ${inheritedRoot}/${label}-claim`);
  }

  for (const [label, id] of [
    ["child-name", "66666666-6666-4666-8666-666666666666"],
    ["parent-name", "77777777-7777-4777-8777-777777777777"],
  ]) {
    let stem = parentStem;
    if (label === "parent-name") {
      stem = join(standardSessions, "fixture", "arbitrary-parent");
      writeFileSync(`${stem}.jsonl`, readFileSync(parentFile), { mode: 0o600 });
      mkdirSync(join(stem, "tasks"), { recursive: true, mode: 0o755 });
    }
    const file = join(stem, "tasks", `${label === "child-name" ? "arbitrary-child" : id}.jsonl`);
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session", version: 3, id, parentSession: parentId, timestamp: new Date().toISOString(), cwd })}\n`,
      { mode: 0o600 },
    );
    const badTopology = await make("editor", persistedParent, undefined, SessionManager.open(file));
    const input = { command: `mkdir -p ${inheritedRoot}/${label}-claim` };
    assert.equal((await badTopology.callAs(`file-effects-${label}`, "bash", input))?.block, true);
    assert.equal(
      input.command,
      `mkdir -p ${inheritedRoot}/${label}-claim`,
      "Header UUIDs must match actual file topology",
    );
  }

  renameSync(inheritedRoot, `${inheritedRoot}.old`);
  externalScratch.push(`${inheritedRoot}.old`);
  mkdirSync(inheritedRoot, { mode: 0o700 });
  externalScratch.push(inheritedRoot);
  const replaced = { command: `mkdir -p ${inheritedRoot}/replaced` };
  assert.equal(
    (await persistedChild.callAs("file-effects-replaced", "bash", replaced))?.block,
    true,
  );
  assert.equal(
    replaced.command,
    `mkdir -p ${inheritedRoot}/replaced`,
    "Same path with a new inode invalidates provenance",
  );
  console.log(
    "PASS: process-observed mktemp provenance, protected parent journal, exact mkdir/cp effects, source/type/inode/profile negatives",
  );

  // Real SDK, not a manually fabricated provenance flag: ORIGINAL explicit
  // exact/wildcard rules must survive the different normalized command text.
  const policyBefore = readFileSync(configPath, "utf8");
  try {
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.bash["git log -5 --oneline"] = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const explicit = await make();
      const before = uiCalls;
      assert.equal(
        (await explicit.call("bash", { command: "git log -5 --oneline" }))?.block,
        true,
        `Original ${action} is not normalized away`,
      );
      assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
    }
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.managed_static_read = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const disabled = await make();
      assert.equal(
        (await disabled.call("bash", { command: "git diff --stat" }))?.block,
        true,
        "Dedicated opt-in can disable deterministic read grants",
      );
      const before = uiCalls;
      assert.equal(
        (await disabled.call("bash", { command: "git status --short && cat ordinary.txt" }))?.block,
        undefined,
        "Fixture-only read-command allowances survive with new static grants disabled",
      );
      assert.equal(uiCalls, before);
    }
    {
      const policy = JSON.parse(policyBefore);
      policy.permission.managed_static_file_effects = "ask";
      writeFileSync(configPath, JSON.stringify(policy));
      const disabled = await make();
      const root = await observeMktemp(disabled, "file-optout");
      const input = { command: `mkdir -p ${root}/disabled` };
      assert.equal((await disabled.callAs("file-optout", "bash", input))?.block, true);
      assert.match(
        input.command,
        /^mkdir -p -- /,
        "Opt-out disables only the grant, not exact effect extraction",
      );
    }
    for (const [surface, pattern] of [
      ["original", "mkdir -p *"],
      ["hardened", "mkdir -p -- *"],
    ]) {
      for (const action of ["ask", "deny"]) {
        const policy = JSON.parse(policyBefore);
        policy.permission.bash[pattern] = action;
        writeFileSync(configPath, JSON.stringify(policy));
        const specific = await make();
        const root = await observeMktemp(specific, `${surface}-${action}`);
        const input = { command: `mkdir -p ${root}/specific` };
        const before = uiCalls;
        assert.equal(
          (await specific.callAs(`file-${surface}-${action}`, "bash", input))?.block,
          true,
          `${surface} ${action} rule wins file-effect proof`,
        );
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
    mkdirSync(join(cwd, "nested-alias"));
    writeFileSync(join(cwd, "nested-alias/copy-a.txt"), "nested alias fixture\n");
    for (const [pattern, prefix, source] of [
      ["./copy-a.txt", "", "./copy-a.txt"],
      ["copy-a.txt", "cd nested-alias && ", "copy-a.txt"],
    ]) {
      for (const action of ["ask", "deny"]) {
        const policy = JSON.parse(policyBefore);
        policy.permission.path_read = { ...policy.permission.path_read, [pattern]: action };
        writeFileSync(configPath, JSON.stringify(policy));
        const specific = await make();
        const root = await observeMktemp(
          specific,
          `source-alias-${action}-${prefix ? "cd" : "dot"}`,
        );
        const input = { command: `${prefix}cp ${source} ${root}/alias-output` };
        const original = input.command;
        const before = uiCalls;
        assert.equal(
          (await specific.call("bash", input))?.block,
          true,
          "Original source aliases retain exact READ rules",
        );
        assert.notEqual(input.command, original, "Source alias rule is checked after effect proof");
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
    for (const action of ["ask", "deny"]) {
      const policy = JSON.parse(policyBefore);
      policy.permission.path_write["/tmp/tmp.*/guarded"] = action;
      writeFileSync(configPath, JSON.stringify(policy));
      const specific = await make();
      const root = await observeMktemp(specific, `directory-${action}`);
      mkdirSync(join(root, "guarded"));
      for (const command of [
        `cp copy-a.txt ${root}/guarded`,
        `cp copy-a.txt copy-b.txt ${root}/guarded`,
        `mkdir -p ${root}/guarded`,
      ]) {
        const input = { command };
        const before = uiCalls;
        assert.equal(
          (await specific.call("bash", input))?.block,
          true,
          "Explicit directory WRITE rule survives derived targets and mkdir no-op",
        );
        assert.notEqual(
          input.command,
          command,
          "Directory rule is checked after exact effects were proved",
        );
        assert.equal(uiCalls - before, action === "ask" ? 1 : 0);
      }
    }
  } finally {
    writeFileSync(configPath, policyBefore);
  }
  console.log(
    "PASS: actual SDK original explicit asks/denies and opt-in disable survive normalization",
  );

  for (const order of ["before", "after"]) {
    const duplicate = await make(undefined, undefined, order);
    const result = await duplicate.call("read", { path: "ordinary.txt" });
    assert.equal(result?.block, true, `Duplicate authority (${order}) must fail closed`);
    assert.match(result.reason, /authority is missing or duplicated/);
  }
  console.log("PASS: duplicate authority detected in either extension load order");

  // Session yolo from the approval indicator, through the actual patched
  // authority: a root's grant reaches its in-process child, never another
  // root, and it only turns asks into allows -- explicit denies still hold.
  const yoloKey = Symbol.for("@rocklee/managed-permissions:session-yolo");
  assert(
    readFileSync(join(repo, "extensions/lib/approval-protocol.ts"), "utf8").includes(
      'Symbol.for("@rocklee/managed-permissions:session-yolo")',
    ),
    "Indicator and authority share the yolo key",
  );
  const yoloChild = sessions.find((node) => node.parent === root);
  assert(yoloChild, "a child of the root session exists");
  const otherRoot = await make();
  // Direct emitToolCall dispatch intentionally bypasses harness tool exposure:
  // researcher has no Bash tool there. The fixture's global `printf *` allow
  // lets the path_write ceiling decide redirects; `printenv HOME` instead
  // exercises the explicit Bash deny. Neither command is executed here.
  const yoloResearcher = await make("researcher", root);
  const writeNames = [
    "ordinary.txt",
    "ordinary.pem",
    "ordinary.key",
    "ordinary.p12",
    "ordinary.pfx",
  ];
  for (const name of writeNames.slice(1))
    writeFileSync(join(cwd, name), "SYNTHETIC_WRITE_POLICY_FIXTURE\n");
  const asked = async (node, command) => {
    const before = { ui: uiCalls, model: modelCalls };
    const blocked = (await node.call("bash", { command }))?.block === true;
    return { blocked, reachedReview: uiCalls !== before.ui || modelCalls !== before.model };
  };
  assert.deepEqual(
    await asked(root, "printenv HOME"),
    { blocked: true, reachedReview: true },
    "An ordinary ask before yolo",
  );
  for (const name of writeNames) {
    assert.deepEqual(
      await asked(yoloResearcher, `printf '%s' fixture > ./${name}`),
      { blocked: true, reachedReview: false },
      `Researcher path-write ceiling blocks without review: ${name}`,
    );
  }
  globalThis[yoloKey] = new Set([root.id]);
  try {
    for (const node of [root, yoloChild]) {
      assert.deepEqual(
        await asked(node, "printenv HOME"),
        { blocked: false, reachedReview: false },
        `yolo allows the ask without UI or judge (${node === root ? "root" : "child"})`,
      );
      for (const command of ["cat .env", "sudo true"])
        assert.deepEqual(
          await asked(node, command),
          { blocked: true, reachedReview: false },
          `yolo keeps the explicit deny: ${command}`,
        );
      assert.equal(
        (await node.call("read", { path: ".env" }))?.block,
        true,
        "yolo keeps secret path denies",
      );
    }
    assert.deepEqual(
      await asked(otherRoot, "printenv HOME"),
      { blocked: true, reachedReview: true },
      "Another root session keeps asking",
    );
    assert.deepEqual(
      await asked(yoloResearcher, "printenv HOME"),
      { blocked: true, reachedReview: false },
      "Researcher Bash denial survives yolo",
    );
    for (const name of writeNames) {
      assert.deepEqual(
        await asked(yoloResearcher, `printf '%s' fixture > ./${name}`),
        { blocked: true, reachedReview: false },
        `Researcher path-write ceiling survives yolo: ${name}`,
      );
      assert.deepEqual(
        await asked(root, `printf '%s' fixture > ./${name}`),
        { blocked: false, reachedReview: false },
        `Normal yolo approves the parent's ordinary path writes: ${name}`,
      );
    }
  } finally {
    globalThis[yoloKey].clear();
  }
  assert.deepEqual(
    await asked(root, "printenv HOME"),
    { blocked: true, reachedReview: true },
    "Clearing yolo restores the ask at once",
  );
  // The retired Git proof matrix now explicitly exercises normal SDK review.
  // These are gate observations only: no requested Git command is executed.
  for (const command of [
    ...new Set([
      ...gitRequested,
      ...nativeReads,
      ...weeklyRequested.filter((command) => command.startsWith("git ")),
    ]),
  ]) {
    const expected = (await check(command)).bash.state;
    const result = await asked(root, command);
    assert.equal(result.blocked, expected !== "allow", `ordinary SDK Git permission: ${command}`);
    if (expected === "ask") assert.equal(result.reachedReview, true, command);
  }
  for (const command of [
    "git add ordinary.txt",
    "git commit -m fixture",
    "git branch topic",
    "git tag v1",
  ]) {
    assert.deepEqual(
      await asked(yoloChild, command),
      { blocked: true, reachedReview: true },
      "editor mutation needs normal approval",
    );
    globalThis[yoloKey].add(root.id);
    try {
      assert.deepEqual(
        await asked(yoloChild, command),
        { blocked: false, reachedReview: false },
        "normal yolo can approve editor Git writes",
      );
    } finally {
      globalThis[yoloKey].clear();
    }
  }
  console.log(
    "PASS: ordinary Git SDK review and editor writes/yolo; session yolo retains explicit denies",
  );

  // The Nix Home Manager migration's backup/rewrite assertions stay in the
  // original deployment suite. Portable init instead MUST NOT migrate settings.
  const settings = join(scratch, "settings.json");
  const original = JSON.stringify({
    defaultModel: "fixture",
    enabledModels: ["fixture/custom"],
    packages: ["npm:other"],
    extensions: ["other.ts"],
  });
  writeFileSync(settings, original);
  const env = { ...process.env, PI_CODING_AGENT_DIR: scratch };
  for (let attempt = 0; attempt < 2; attempt++) {
    const initialized = spawnSync(process.execPath, [join(repo, "scripts/init.mjs")], {
      env,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(
      readFileSync(settings, "utf8"),
      original,
      "Portable init never rewrites existing SDK settings",
    );
  }
  console.log("PASS: isolated portable init preserves existing SDK settings across repeated calls");
}
