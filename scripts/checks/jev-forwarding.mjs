// Jev forwarding checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import { allowAnswers, mockResponse, wireAnswers, hashJson } from "./jev-wire.mjs";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { nextHarnessSerial } from "./jev-harness.mjs";
export async function runJevTransport(
  check,
  reviewWithNativeJev,
  QUESTIONS,
  JEV_MODEL,
  MODEL_ID,
  JEV_ENDPOINT,
  normalizedAnswers,
  nativeQuestions,
) {
  // Classifier transport regressions are separate from policy-unit noul inputs.
  // Every probe replaces fetch, so none can escape to the network.
  const classifierPacket = { action: "synthetic inspection" };
  const classifierReview = async (handler, signal = new AbortController().signal) => {
    globalThis.fetch = handler;
    return reviewWithNativeJev(
      classifierPacket,
      QUESTIONS,
      "offline-test-key-not-a-credential",
      signal,
    );
  };
  const goodWire = () => wireAnswers(allowAnswers());
  const responseOf = (body, status = 200) => new Response(JSON.stringify(body), { status });
  for (const [label, answers] of [
    [
      "missing",
      (() => {
        const wire = goodWire();
        delete wire.task_scope;
        return wire;
      })(),
    ],
    ["wrong wire type", { ...goodWire(), task_scope: { type: "bool", probability: 0.99 } }],
    ["wrong score type", { ...goodWire(), risk: { type: "noul", noul: 0.99 } }],
    ["infinite probability", { ...goodWire(), read_only: { type: "noul", noul: "Infinity" } }],
    ["out-of-range score", { ...goodWire(), risk: { type: "score", score: 5, confidence: 0.99 } }],
  ]) {
    const result = await classifierReview(() => responseOf({ answers }));
    check(`${label} typed HTTP answer defers`, result.failureCode, "invalid_model_response");
  }
  const billedMalformed = await classifierReview(() =>
    responseOf({
      answers: { ...goodWire(), task_scope: { type: "bool", probability: 0.99 } },
      usage: { input_tokens: 41 },
    }),
  );
  check("billed malformed response retains audit usage but no answers", billedMalformed, {
    failureCode: "invalid_model_response",
    inputTokens: 41,
  });
  check(
    "non-2xx status is http_error",
    (await classifierReview(() => responseOf({}, 503))).failureCode,
    "http_error",
  );
  check(
    "transport throw is network_error",
    (
      await classifierReview(() => {
        throw new Error("offline transport failure");
      })
    ).failureCode,
    "network_error",
  );
  check(
    "successful HTTP with parser error is invalid_model_response",
    (await classifierReview(() => new Response("{invalid JSON", { status: 200 }))).failureCode,
    "invalid_model_response",
  );
  const deadline = new AbortController();
  check(
    "deadline abort is timeout",
    (
      await classifierReview(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("synthetic abort"), { name: "AbortError" })),
            );
            deadline.abort();
          }),
        deadline.signal,
      )
    ).failureCode,
    "timeout",
  );
  const wrongIdentity = {
    api: JEV_MODEL.api,
    provider: "wrong-provider",
    model: MODEL_ID,
    stopReason: "stop",
    answers: { task_scope: { type: "bool", probability: 0.99 } },
  };
  check(
    "wrong result identity is rejected before policy composition",
    normalizedAnswers(wrongIdentity, nativeQuestions(QUESTIONS)),
    undefined,
  );
  const abortBefore = new AbortController();
  abortBefore.abort();
  check(
    "caller abort is cancelled",
    (
      await classifierReview(() => {
        throw new Error("fetch must not run");
      }, abortBefore.signal)
    ).failureCode,
    "cancelled",
  );
  let guardedUrl, guardedInit;
  const guardedResult = await classifierReview((url, init) => {
    guardedUrl = String(url);
    guardedInit = init;
    return mockResponse(allowAnswers());
  });
  check(
    "native typed answers become noul for unchanged policy",
    guardedResult.answers?.task_scope?.noul,
    0.95,
  );
  check("native classifier retains input token audit", guardedResult.inputTokens, 1);
  check("native classifier pins endpoint", guardedUrl, JEV_ENDPOINT);
  check("native classifier blocks redirects", guardedInit.redirect, "error");
  check("native classifier sends the pinned model", JSON.parse(guardedInit.body).model, MODEL_ID);
  check(
    "native classifier sends wire noul",
    JSON.parse(guardedInit.body).questions.task_scope.type,
    "noul",
  );

  // A shadow review returns its ask immediately. The native provider may await a
  // lazy import before dispatch, while the next review installs its own HTTP mock.
  // Each request must retain the transport present at its own admission point.
  let firstTransportCalls = 0,
    secondTransportCalls = 0;
  globalThis.fetch = async () => {
    firstTransportCalls++;
    return mockResponse(allowAnswers(0.01));
  };
  const firstTransport = reviewWithNativeJev(
    classifierPacket,
    QUESTIONS,
    "offline-test-key-not-a-credential",
    new AbortController().signal,
  );
  globalThis.fetch = async () => {
    secondTransportCalls++;
    return mockResponse(allowAnswers());
  };
  const secondTransport = reviewWithNativeJev(
    classifierPacket,
    QUESTIONS,
    "offline-test-key-not-a-credential",
    new AbortController().signal,
  );
  const [firstAnswer, secondAnswer] = await Promise.all([firstTransport, secondTransport]);
  check(
    "first overlapping review keeps its under-threshold HTTP response",
    firstAnswer.answers?.task_scope?.noul,
    0.01,
  );
  check(
    "second overlapping review keeps its own HTTP response",
    secondAnswer.answers?.task_scope?.noul,
    0.95,
  );
  check(
    "overlapping reviews each use only their bound fetch",
    [firstTransportCalls, secondTransportCalls],
    [1, 1],
  );
}

export async function runJevForwarding(
  check,
  registeredHarness,
  offlineAgentDir,
  offlineRuntime,
  piRoot,
  jiti,
  repo,
  jevAutoApproval,
  defaultSystemPrompt,
) {
  // Eligible root asks through the actual registered Jev authorizer. Dangerous
  // prefixes are normally stopped by the earlier static guard; deliberately
  // injecting them here tests the checkpoint independently, not a full pipeline.
  // The approve-only transport is synthetic, including its reversible-write
  // answers. A checkpoint means DEFER to normal authority, not a yolo/ALLOW ban.
  for (const command of [
    "PATH=./fixture-bin git status",
    "LD_PRELOAD=./fixture.so git status",
    "GIT_EXTERNAL_DIFF=./fixture git diff",
    "/usr/bin/env GIT_EDITOR=./fixture /usr/bin/git status",
    "EDITOR=./fixture git status",
    "env VISUAL='./fixture helper' git status",
    "GIT_PROXY_COMMAND=./fixture git status",
    "LC_ALL=C git status",
    "FOO=1 git status",
    "env LC_ALL=C git status",
    "env -- FOO=1 git status",
    "LC_ALL=$(pwd) git status",
    "git checkout -- .",
    "git checkout .",
    "git checkout f",
    "git checkout topic",
    "git restore .",
    "git branch -df main",
    "git checkout --forc",
    `git checkout '--forc'`,
    `git checkout 'topic name'`,
    "git checkout -p",
    "git checkout -qp",
    "git checkout -pq",
    "git checkout --patch",
    "git checkout --pat",
    `git checkout '--patch'`,
    "git checkout -pU3",
    "git checkout -qpU3",
    "git checkout -U3 -p",
    "git checkout --unified=3 -p",
    "git checkout --inter-hunk-context 3 -p",
    "git checkout -p --unified 3",
    "git clean -i",
    "git clean -qi",
    "git clean --interactive",
    "git clean --inter",
    "git reset --merge",
    "git reset --mer HEAD",
    "git switch -f topic",
    "git switch --discard-changes topic",
    "git switch -Ctopic",
    "git switch --force-create topic",
    "git branch -f topic",
    "git branch -M old new",
    "git branch -C old new",
    "git branch --force topic",
    "git tag -f v1",
    "git tag --force v1",
    "git reset --har HEAD",
    `git reset '--har' HEAD`,
    "git reset HEAD --har",
    "git clean --forc",
    "git tag --del t",
    `git tag '--del' t`,
    "git tag t --del",
    "git branch --delete-merged '*'",
    "git branch -v --delete-merged '*'",
    "git branch -v --delete-merged='*'",
    "git branch topic --delete-mer '*' -v",
    `git branch -v '--delete-merged' '*'`,
    "git stash clear",
    "git update-ref -d refs/heads/main",
    "git filter-branch --all",
    "git checkout -f main",
    "git checkout -B main",
    "git branch -fd main",
    "git branch -d main",
    "git stash drop",
    "git reset --hard",
    "git clean -fd",
    "git push --force",
    "git reflog expire --all",
    "git branch -D main",
    "git tag -d v1",
    "git -c core.pager=./fixture status",
    "GIT_CONFIG_PARAMETERS=x git status",
    "git diff --ext-diff",
    "git log --textconv",
    "git diff --output=fixture.txt",
    "git --unknown status",
  ]) {
    const h = registeredHarness();
    h.live("Perform the requested synthetic local Git action.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse({ ...allowAnswers(), read_only: { noul: 0.01 } });
    };
    check(
      `Git checkpoint defers: ${command}`,
      await h.authorize(h.call("git-checkpoint", command)),
      {
        kind: "defer",
      },
    );
    check(`Git checkpoint skips approve-only reviewer: ${command}`, fetchCalls, 0);
    const audit = h.reviews.at(-1);
    check(
      `Git checkpoint audit: ${command}`,
      [audit.failureCode, audit.checkpointReason, audit.modelCalled],
      ["hard_checkpoint", "high_impact_command", false],
    );
  }
  for (const command of [
    "git status",
    "git add ordinary.txt",
    "git commit -m fixture",
    "env git status",
    "git checkout -",
    `git checkout '-'`,
    "git checkout -b topic",
    "git checkout -bfixture",
    "git checkout -qbfeature",
    "git checkout --conflict '--forc'",
    "git checkout -qb --forc",
    "git checkout --orphan --forc",
    "git checkout -bpatch",
    "git checkout -qbpatch",
    "git checkout -b --patch",
    "git checkout --conflict '--patch'",
    "git checkout --conf '--pat'",
    "git checkout --conflict=--patch",
    "git checkout -b --interactive",
    "git checkout -U3",
    "git checkout --unified 3",
    "git checkout --inter-hunk-context 3",
    "git clean --exclude -i",
    "git clean -einteractive",
    "git clean -- --interactive",
    "git reset -- --merge",
    "git reset --pathspec-from-file --merge",
    "git switch -c topic",
    "git switch -c --discard-changes",
    "git switch --create=--force",
    "git switch -- --discard-changes",
    "git branch --format -M",
    "git branch --sort --force",
    "git branch -- -M",
    "git tag -m-f",
    "git tag -F -f",
    "git tag --format --force",
    "git tag -- --force",
    "git reset -- --hard",
    "git reset -- --har",
    "git reset --pathspec-from-file '--har'",
    `git reset '--har HEAD'`,
    "git tag -- --delete",
    "git tag -- --del",
    "git tag --format '--delete'",
    "git tag -m --del",
    "git tag -m-d",
    "git branch -- --delete-merged",
    "git branch --format '--delete-merged'",
    "git branch --form --del",
    "git branch --sort=--delete-merged",
    "git branch --list",
    "git branch main-data",
    "git branch -- -df",
    "git branch --list -- -d",
    "git branch --format -d",
    "git branch --sort -d",
    "git tag -- -d",
    "git stash list",
  ]) {
    const h = registeredHarness();
    h.live("Perform the requested synthetic local Git action.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse({ ...allowAnswers(), read_only: { noul: 0.01 } });
    };
    check(
      `ordinary Git ask reaches reviewer: ${command}`,
      await h.authorize(h.call("git-ordinary", command)),
      { kind: "allow" },
    );
    check(`ordinary Git ask uses approve-only reviewer once: ${command}`, fetchCalls, 1);
  }

  // Exercise the real profile lookup through the registered authorizer, not a
  // stubbed boundedProfileIsValid. A copied, intact rendered profile must allow a
  // well-bound child; missing/changed profiles and product limits must defer.
  for (const variant of [
    "intact",
    "prompt-at-limit",
    "prompt-over-limit",
    "wrong-cwd",
    "changed-profile",
    "missing-profile",
    "other-tool-start",
    "other-tool-end",
    "legacy-disposed",
    "current-tool-changed",
    "current-tool-ended",
    "current-ask-rebound",
    "current-run-changed",
  ]) {
    const h = registeredHarness({ mode: "enforce-subagents" });
    h.live("Inspect repository status with the worker.");
    const profile = "editor",
      profilePath = join(offlineAgentDir, "agents", `${profile}.md`);
    const originalProfile = readFileSync(profilePath);
    const definitionDigest = createHash("sha256").update(originalProfile).digest("hex");
    const sessionId = `${h.ctx.sessionManager.getSessionId()}-child`;
    const taskPrompt = variant.startsWith("prompt-")
      ? "inspect ".repeat(1024) + (variant === "prompt-over-limit" ? "x" : "")
      : "Inspect repository status.";
    const identity = {
      owner_id: h.ctx.sessionManager.getSessionId(),
      generation: "fixture-generation",
      agent_id: `${sessionId}-agent`,
      run_id: `${sessionId}-run`,
    };
    const details = h.call("forwarded-profile");
    h.branch.pop(); // No child transcript inference in the parent.
    const toolCallId = details.toolCallId;
    delete details.toolCallId; // The actual forwarded wire format omits this.
    details.agentName = profile;
    details.forwarding = { requesterSessionId: sessionId, requesterAgentName: profile };
    details.payload.request.requester = { forwarded: true, sessionId, agentName: profile };
    details.accessIntent = { surface: "bash", matchValues: ["git status"] };
    globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")] = new Map([
      [
        sessionId,
        {
          parentSessionId: identity.owner_id,
          cwd: variant === "wrong-cwd" ? join(h.ctx.cwd, "other") : h.ctx.cwd,
          contextChanged: false,
          initialPromptDigest: hashJson(taskPrompt),
          harness: {
            ...identity,
            protocol: 1,
            profile,
            definitionDigest,
            task_prompt: taskPrompt,
            prompt: taskPrompt,
            systemPrompt: defaultSystemPrompt(),
          },
          toolCalls: {
            [toolCallId]: { name: "bash", arguments: { command: "git status" } },
            other: { name: "bash", arguments: { command: "git status" } },
          },
          requestTools: { [details.requestId]: toolCallId, "other-request": "other" },
        },
      ],
    ]);
    const facts =
      globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")].get(sessionId);
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      // Mutate the live registry while this review is outstanding. Unrelated
      // preflights/asks must not stale it; this call's evidence and Run still must.
      if (variant === "other-tool-start") {
        facts.toolCalls.later = { name: "bash", arguments: { command: "git diff" } };
        facts.requestTools["later-request"] = "later";
      }
      if (variant === "other-tool-end") {
        delete facts.toolCalls.other;
        delete facts.requestTools["other-request"];
      }
      if (variant === "legacy-disposed") h.bus.get("subagents:child:disposed")?.({ sessionId });
      if (variant === "current-tool-changed")
        facts.toolCalls[toolCallId].arguments.command = "git diff";
      if (variant === "current-tool-ended") delete facts.toolCalls[toolCallId];
      if (variant === "current-ask-rebound") facts.requestTools[details.requestId] = "other";
      if (variant === "current-run-changed") facts.contextChanged = true;
      return mockResponse(allowAnswers());
    };
    try {
      if (variant === "changed-profile")
        writeFileSync(profilePath, `${originalProfile}\nChanged fixture definition.\n`);
      if (variant === "missing-profile") rmSync(profilePath);
      h.bus.get("pi-harness:approval:admitted")(identity);
      h.bus.get("pi-harness:approval:started")({ sessionId });
      const stale = variant.startsWith("current-");
      const eligible = [
        "intact",
        "prompt-at-limit",
        "other-tool-start",
        "other-tool-end",
        "legacy-disposed",
      ].includes(variant);
      check(`forwarded review / ${variant}`, await h.authorize(details), {
        kind: eligible ? "allow" : "defer",
      });
      check(`forwarded review / ${variant} reviewer calls`, fetchCalls, eligible || stale ? 1 : 0);
      if (!eligible)
        check(
          `forwarded review / ${variant} fails closed`,
          h.reviews.at(-1).failureCode,
          stale ? "review_context_changed" : "delegation_unbound",
        );
    } finally {
      writeFileSync(profilePath, originalProfile);
      globalThis[Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts")].delete(sessionId);
    }
  }

  // A completed model answer is only a suggestion when any authority-bearing
  // snapshot changed. The stale audit must retain model use, latency and verdict.
  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    const details = h.call("stale-input");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    h.live("Stop; do not run that action.");
    release();
    check("changed direct input makes an awaited review stale", await pending, { kind: "defer" });
    const audit = h.reviews.at(-1);
    check("stale audit records the model call", audit.modelCalled, true);
    check("stale audit keeps the model suggestion", audit.suggestedVerdict, "allow");
    check("stale audit records effective defer", audit.effectiveVerdict, "defer");
    check("stale audit names freshness failure", audit.failureCode, "review_context_changed");
    check("stale audit retains latency", typeof audit.latencyMs, "number");
  }

  // An actual indicator and actual Jev handler must agree even if Jev's toast
  // fails. Pi's SDK event bus catches an event-handler throw asynchronously, so
  // the direct Map bus in registeredHarness cannot detect a swallowed publish.
  // Use the real approval extension (its lifecycle is covered by check-pi-ui) and
  // Pi's safe-dispatch bus, with only terminal callbacks and storage isolated.
  {
    const { createEventBus } = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")));
    const { default: approvalMode, APPROVAL_ENTRY } = await jiti.import(
      join(repo, "extensions/approval-mode.ts"),
    );
    const bus = createEventBus();
    const hooks = new Map(),
      commands = new Map(),
      statuses = new Map(),
      entries = [];
    const published = [],
      requests = [],
      confirmations = [],
      toasts = [];
    const sessionId = `jev-indicator-${nextHarnessSerial()}`;
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const ctx = {
      cwd: offlineRuntime,
      mode: "json",
      hasUI: true,
      sessionManager: {
        getSessionId: () => sessionId,
        getHeader: () => ({}),
        getBranch: () => entries,
      },
      ui: {
        theme,
        setStatus: (key, value) => statuses.set(key, value),
        confirm: async (title) => {
          confirmations.push(title);
          return true;
        },
        notify: (message) => {
          if (message.startsWith("Jev approval:")) throw new Error("injected Jev toast failure");
          toasts.push(message);
        },
      },
    };
    const pi = {
      events: bus,
      on(name, handler) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name, command) {
        commands.set(name, command);
      },
      appendEntry(customType, data) {
        entries.push({ type: "custom", customType, data });
      },
    };
    approvalMode(pi);
    jevAutoApproval(pi); // The rendered Jev extension, not a stand-in judge.
    bus.on("approval:judge-state", (state) => {
      published.push({ ...state });
    });
    bus.on("approval:set-judge", (request) => {
      requests.push(request);
    });
    const previousMode = process.env.PI_JEV_APPROVAL_MODE;
    const previousError = console.error;
    const busErrors = [];
    console.error = (...args) => {
      busErrors.push(args.map(String).join(" "));
    };
    try {
      process.env.PI_JEV_APPROVAL_MODE = "shadow";
      for (const handler of hooks.get("session_start") ?? []) handler({}, ctx);
      // Let the indicator's startup restore microtask settle before choosing.
      await new Promise((done) => setImmediate(done));
      check("real indicator starts manual", statuses.get("approval"), "approval: manual");
      check("real judge starts in shadow", published.at(-1)?.mode, "shadow");
      const auditPath = join(offlineAgentDir, "logs/jev-auto-approval.jsonl");
      const modes = () =>
        readFileSync(auditPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((row) => row.event === "jev_model_judge.mode_changed");
      const before = existsSync(auditPath) ? modes().length : 0;
      const choose = async (choice, mode, includeSubagents, indicator, confirmationCount) => {
        await commands.get("approval").handler(choice, ctx);
        // The SDK bus handles rejections after emit returns, on the next tick.
        await new Promise((done) => setImmediate(done));
        check(`${choice}: actual judge claimed request`, requests.at(-1)?.applied, true);
        check(`${choice}: published committed mode`, published.at(-1)?.mode, mode);
        check(
          `${choice}: published committed scope`,
          published.at(-1)?.includeSubagents,
          includeSubagents,
        );
        check(`${choice}: published session`, published.at(-1)?.sessionId, sessionId);
        check(`${choice}: real indicator claimed publication`, published.at(-1)?.shown, true);
        check(`${choice}: indicator renders committed mode`, statuses.get("approval"), indicator);
        check(
          `${choice}: judge fallback status is cleared`,
          statuses.get("jev-auto-approval"),
          undefined,
        );
        const record = entries.filter((entry) => entry.customType === APPROVAL_ENTRY).at(-1)?.data;
        check(`${choice}: recorded committed mode`, record?.judge, { mode, includeSubagents });
        check(`${choice}: record belongs to current session`, record?.sessionId, sessionId);
        check(`${choice}: no yolo authority`, record?.yolo, false);
        check(`${choice}: toast failure does not escape the SDK bus`, busErrors, []);
        check(`${choice}: confirmation count`, confirmations.length, confirmationCount);
      };
      await choose("judge+sub", "enforce", true, "approval: jev+sub", 1);
      await choose("judge", "enforce", false, "approval: jev", 1);
      await choose("manual", "shadow", false, "approval: manual", 1);
      const changed = modes().slice(before);
      check(
        "toast failures preserve all three mode-change audits",
        changed.map((row) => [
          row.previousMode,
          row.previousIncludeSubagents,
          row.mode,
          row.includeSubagents,
        ]),
        [
          ["shadow", false, "enforce", true],
          ["enforce", true, "enforce", false],
          ["enforce", false, "shadow", false],
        ],
      );
      const unchanged = { mode: "shadow", includeSubagents: false, applied: false };
      bus.emit("approval:set-judge", unchanged);
      await new Promise((done) => setImmediate(done));
      check("unchanged request still acknowledged", unchanged.applied, true);
      check("unchanged request is not audited again", modes().length, before + 3);
      check(
        "unchanged request does not add a record",
        entries.filter((entry) => entry.customType === APPROVAL_ENTRY).length,
        3,
      );
      check("no mode-change event errors leaked to the SDK bus", busErrors, []);
      check("Jev toast failure never reaches another UI notice", toasts, []);
    } finally {
      try {
        for (const handler of hooks.get("session_shutdown") ?? []) await handler({}, ctx);
      } finally {
        console.error = previousError;
        process.env.PI_JEV_APPROVAL_MODE = previousMode;
        bus.clear();
      }
    }
  }

  // The approval indicator is the runtime way to change jev's mode. The judge
  // publishes every mode, keeps its own status only while nobody renders it, and
  // a change mid-review cannot commit a verdict under the previous mode.
  {
    const h = registeredHarness({ mode: "enforce" });
    check("session start publishes the launch mode", h.published.at(-1), {
      name: "approval:judge-state",
      data: {
        judge: "jev",
        mode: "enforce",
        includeSubagents: false,
        sessionId: h.ctx.sessionManager.getSessionId(),
        shown: false,
      },
    });
    check("unclaimed, the judge keeps its own status", h.statuses.at(-1), [
      "jev-auto-approval",
      "jev: ENFORCE",
    ]);
    h.bus.set("approval:judge-state", (state) => {
      state.shown = true;
    });
    check("a well-formed request is applied", h.setMode("enforce", true), true);
    check("the new mode is published", h.published.at(-1).data, {
      judge: "jev",
      mode: "enforce",
      includeSubagents: true,
      sessionId: h.ctx.sessionManager.getSessionId(),
      shown: true,
    });
    check("an indicator that renders it clears the judge's status", h.statuses.at(-1), [
      "jev-auto-approval",
      undefined,
    ]);
    check("shadow cannot cover subagents", h.setMode("shadow", true), false);
    check("an unknown mode is refused", h.setMode("yolo", false), false);
    check("a refused request changes nothing", h.published.at(-1).data.includeSubagents, true);

    h.live("Inspect repository status.");
    const details = h.call("mode-change-mid-review");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    check("switching to manual mid-review is applied", h.setMode("shadow", false), true);
    release();
    check("a review started under enforce cannot allow after the switch", await pending, {
      kind: "defer",
    });
    check(
      "the switch is audited as a context change",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }

  {
    const h = registeredHarness({ mode: "enforce" });
    h.bus.set("approval:judge-state", (state) => {
      state.shown = true;
    });
    h.setMode("enforce", true);
    h.live("Inspect repository status.");
    const details = h.call("mode-round-trip-mid-review");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    check("round trip: manual is applied mid-review", h.setMode("shadow", false), true);
    check("round trip: the original mode is applied again", h.setMode("enforce", true), true);
    release();
    check("a review started before a mode round trip cannot allow", await pending, {
      kind: "defer",
    });
    check(
      "the round trip is audited as a context change",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }

  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    const details = h.call("stale-policy");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    h.queryState.value = "deny";
    release();
    check("changed permission summary makes review stale", await pending, { kind: "defer" });
    check("policy-stale audit keeps allow suggestion", h.reviews.at(-1).suggestedVerdict, "allow");
    check(
      "policy-stale audit marks context change",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }

  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    const details = h.call("stale-signal");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    h.abort.abort();
    release();
    check("aborted review signal makes answer stale", await pending, { kind: "defer" });
    check(
      "signal-stale audit marks context change",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }

  {
    const h = registeredHarness({ withSignal: false });
    h.live("Inspect repository status.");
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return mockResponse(allowAnswers());
    };
    check(
      "undefined extension signal keeps a current review eligible",
      await h.authorize(h.call("undefined-signal")),
      { kind: "allow" },
    );
    check("undefined signal still performs exactly one review", fetchCalls, 1);
    check(
      "undefined signal does not create a stale-review audit",
      h.reviews.at(-1).failureCode,
      null,
    );
  }

  {
    const h = registeredHarness();
    h.live("Inspect repository status.");
    const details = h.call("stale-project");
    let release;
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    globalThis.fetch = async () => {
      startedResolve();
      await new Promise((resolve) => {
        release = resolve;
      });
      return mockResponse(allowAnswers());
    };
    const pending = h.authorize(details);
    await started;
    h.setSystemPrompt(
      defaultSystemPrompt().replace(
        "Do not expose credentials.",
        "Do not expose credentials. Never modify deployment state.",
      ),
    );
    release();
    check("changed loaded project restrictions make review stale", await pending, {
      kind: "defer",
    });
    check(
      "project-stale audit marks context change",
      h.reviews.at(-1).failureCode,
      "review_context_changed",
    );
  }
}
