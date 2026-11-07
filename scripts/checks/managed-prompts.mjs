// Managed prompt lifecycle checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
export async function runPromptLifecycle(
  LocalUserAuthorizer,
  promptQueue,
  terminalTitle,
  createFailClosedToolCall,
) {
  // This joins the real built LocalUserAuthorizer to the production prompt queue.
  // It deliberately observes only the lifecycle id: no result, error or content
  // becomes an event payload, and a fail-closed boundary must retain its own id.
  const PROMPT_END_EVENT = "managed-permissions:ui_prompt_end:v1";
  const permissionDetails = (requestId, forwarding) => ({
    requestId,
    source: "tool_call",
    agentName: "fixture",
    toolName: "bash",
    command: "sleep 7",
    payload: { request: { surface: "bash", value: "sleep 7" } },
    ...(forwarding ? { forwarding } : {}),
  });
  const eventBus = () => {
    const handlers = new Map();
    const emitted = [];
    return {
      emitted,
      events: {
        on(channel, handler) {
          const list = handlers.get(channel) ?? [];
          handlers.set(channel, [...list, handler]);
          return () =>
            handlers.set(
              channel,
              (handlers.get(channel) ?? []).filter((entry) => entry !== handler),
            );
        },
        emit(channel, data) {
          // Snapshot before a synchronous observer can mutate the public object.
          emitted.push({ channel, data: structuredClone(data) });
          for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
        },
      },
    };
  };
  const endEvents = (bus, requestId) =>
    bus.emitted.filter(
      (event) => event.channel === PROMPT_END_EVENT && event.data.requestId === requestId,
    );
  const assertOnePromptEnd = (bus, requestId) => {
    const events = endEvents(bus, requestId);
    assert.equal(events.length, 1, `one lifecycle end for ${requestId}`);
    assert.deepEqual(
      events[0].data,
      { requestId },
      "end observation has no decision, error, or content",
    );
  };
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  // All outcomes after the start broadcast end the original prompt id. The
  // captured id survives a mutable start payload and an end observer failure.
  {
    const bus = eventBus();
    const ui = {};
    const approved = { approved: true, state: "approved", decidedBy: { kind: "human" } };
    const preferences = { doublePressToConfirm: true, budget: { width: 80 } };
    let request;
    bus.events.on("permissions:ui_prompt", (event) => {
      event.requestId = "observer-mutated-id";
    });
    bus.events.on(PROMPT_END_EVENT, () => {
      throw new Error("observer failure");
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      mode: "tui",
      events: bus.events,
      getPromptPreferences: () => preferences,
      requestPermissionDecision: async (...args) => {
        request = args;
        return approved;
      },
    });
    const forwarded = { requesterAgentName: "worker", requesterSessionId: "child" };
    assert.strictEqual(
      await authorizer.authorize(permissionDetails("prompt-success", forwarded)),
      approved,
    );
    const start = bus.emitted.find((event) => event.channel === "permissions:ui_prompt");
    assert.deepEqual(start?.data.forwarding, forwarded, "forwarded prompt metadata is unchanged");
    assert.equal(
      start?.data.requestId,
      "prompt-success",
      "start observer received the original id",
    );
    assert.equal(request[0].ui, ui);
    assert.equal(request[1], "Permission Required (Subagent)");
    assert.strictEqual(request[3], undefined);
    assertOnePromptEnd(bus, "prompt-success");
  }
  {
    const bus = eventBus();
    const refused = { approved: false, state: "denied", decidedBy: { kind: "human" } };
    const authorizer = new LocalUserAuthorizer({
      ui: {},
      mode: "tui",
      events: bus.events,
      getPromptPreferences: () => ({}),
      requestPermissionDecision: async () => refused,
    });
    assert.strictEqual(await authorizer.authorize(permissionDetails("prompt-refusal")), refused);
    assertOnePromptEnd(bus, "prompt-refusal");
  }
  const assertPromptFailure = async (label, error, configure) => {
    const bus = eventBus();
    bus.events.on(PROMPT_END_EVENT, () => {
      throw new Error("observer failure must not mask the original error");
    });
    let requestCalls = 0;
    const deps = {
      ui: {},
      mode: "tui",
      events: bus.events,
      getPromptPreferences: () => ({}),
      requestPermissionDecision: () => {
        requestCalls++;
        throw new Error("unset request");
      },
    };
    const details = permissionDetails(`prompt-${label}`);
    configure(deps, details, () => {
      requestCalls++;
    });
    await assert.rejects(
      new LocalUserAuthorizer(deps).authorize(details),
      (caught) => caught === error,
      `${label} preserves the original error`,
    );
    assertOnePromptEnd(bus, details.requestId);
    return requestCalls;
  };
  {
    const error = new Error("synchronous request failure");
    const calls = await assertPromptFailure("sync-rejection", error, (deps, _details, called) => {
      deps.requestPermissionDecision = () => {
        called();
        throw error;
      };
    });
    assert.equal(calls, 1);
  }
  {
    const error = new Error("asynchronous request failure");
    const calls = await assertPromptFailure("async-rejection", error, (deps, _details, called) => {
      deps.requestPermissionDecision = () => {
        called();
        return Promise.reject(error);
      };
    });
    assert.equal(calls, 1);
  }
  {
    const error = new Error("preferences failure");
    const calls = await assertPromptFailure("preferences-rejection", error, (deps) => {
      deps.getPromptPreferences = () => {
        throw error;
      };
    });
    assert.equal(calls, 0, "a throwing preference reader reaches no dialog");
  }
  {
    const error = new Error("request options failure");
    const calls = await assertPromptFailure("options-rejection", error, (_deps, details) => {
      const approval = {};
      Object.defineProperty(approval, "grants", {
        get: () => {
          throw error;
        },
      });
      details.sessionApproval = approval;
    });
    assert.equal(calls, 0, "a throwing option builder reaches no dialog");
  }

  // Install the real extension wrapper. The first inline ui.custom dialog never
  // settles; Node mock timers advance its production ten-minute bound without
  // waiting. Queue cancellation calls its done handle. The queued successor stays
  // live until this test completes it, and a late first done is inert.
  {
    const queueKey = Symbol.for("nixos-config.pi.ui-prompt-queue.v1");
    const queueGlobals = globalThis;
    const hadQueue = Object.hasOwn(queueGlobals, queueKey);
    const previousQueue = queueGlobals[queueKey];
    let timersEnabled = false;
    try {
      delete queueGlobals[queueKey];
      const sessionHandlers = [];
      promptQueue.default({
        on: (event, handler) => {
          if (event === "session_start") sessionHandlers.push(handler);
        },
      });
      assert.equal(
        sessionHandlers.length,
        1,
        "production prompt queue registered its session hook",
      );
      let customCalls = 0;
      const ui = {
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        editor: async () => undefined,
        custom: (factory) =>
          new Promise((resolve) => {
            customCalls++;
            factory({}, {}, {}, resolve);
          }),
      };
      sessionHandlers[0]({}, { mode: "tui", hasUI: true, ui });
      const bus = eventBus();
      const titleHooks = new Map();
      const titleWrites = [];
      ui.setTitle = (title) => titleWrites.push(title);
      ui.setWidget = () => {};
      terminalTitle.default({
        events: bus.events,
        on(event, handler) {
          const list = titleHooks.get(event) ?? [];
          titleHooks.set(event, [...list, handler]);
          return () =>
            titleHooks.set(
              event,
              (titleHooks.get(event) ?? []).filter((entry) => entry !== handler),
            );
        },
        getSessionName: () => "fixture",
      });
      const titleStart = titleHooks.get("session_start")?.[0];
      assert(titleStart, "title extension registered its session hook");
      titleStart({}, { mode: "tui", cwd: "/fixture", ui });
      const approved = { approved: true, state: "approved", decidedBy: { kind: "human" } };
      let firstDialogDone;
      let successorDone;
      let dialogFactories = 0;
      const requestPermissionDecision = async (view) => {
        await view.ui.custom((_tui, _theme, _keybindings, done) => {
          if (++dialogFactories === 1) firstDialogDone = done;
          else successorDone = done;
          return { render: () => [], invalidate() {} };
        });
        return approved;
      };
      const original = permissionDetails("prompt-timeout");
      const successorDetails = permissionDetails("prompt-worker", {
        requesterAgentName: "worker",
        requesterSessionId: "child",
      });
      const authorizer = new LocalUserAuthorizer({
        ui,
        mode: "tui",
        events: bus.events,
        getPromptPreferences: () => ({}),
        requestPermissionDecision,
      });
      const reviews = [];
      const gate = createFailClosedToolCall(
        async () => {
          await authorizer.authorize(original);
          return { action: "allow" };
        },
        {
          writeReviewLog: (...args) => reviews.push({ type: "log", args }),
          emitDecision(event) {
            reviews.push({ type: "decision", event });
            bus.events.emit("permissions:decision", event);
          },
        },
        { recordDecision() {}, recordError() {} },
        { debug() {} },
      );
      mock.timers.enable({ apis: ["setTimeout"], now: 0 });
      timersEnabled = true;
      const blocked = gate({ toolName: "bash", input: { command: "sleep 7" } }, {});
      let successorSettled = false;
      const successor = authorizer.authorize(successorDetails).then((value) => {
        successorSettled = true;
        return value;
      });
      await flush();
      assert.equal(
        titleWrites.at(-1),
        "! - fixture",
        "original prompt enters approval title state",
      );
      assert.equal(customCalls, 1, "the successor inline dialog is queued behind the stalled one");
      assert.equal(
        typeof firstDialogDone,
        "function",
        "first inline dialog supplied a done handle",
      );
      mock.timers.tick(10 * 60 * 1000);
      const result = await blocked;
      await flush();
      assert.equal(result.block, true, "queue timeout remains fail-closed");
      assert.match(result.reason, /Inline prompt did not settle within 600000ms/);
      assert.equal(
        titleWrites.at(-1),
        "! - fixture",
        "forwarded worker remains pending after the local prompt ends",
      );
      assert.equal(
        customCalls,
        2,
        "queue handed the released slot to its forwarded inline successor",
      );
      assert.equal(typeof successorDone, "function");
      assert.equal(successorSettled, false, "successor remains live until its own done call");
      const gateError = reviews.find((entry) => entry.type === "decision")?.event;
      assert.equal(gateError?.resolution, "gate_error");
      assert.notEqual(
        gateError?.requestId,
        original.requestId,
        "gate error keeps its separately minted id",
      );
      assertOnePromptEnd(bus, original.requestId);
      const endsBeforeLateResolve = endEvents(bus, original.requestId).length;
      firstDialogDone("late approval");
      await flush();
      assert.equal(
        endEvents(bus, original.requestId).length,
        endsBeforeLateResolve,
        "late dialog resolution is inert",
      );
      assert.equal(
        reviews.filter((entry) => entry.type === "decision").length,
        1,
        "late resolution cannot mint another gate decision",
      );
      successorDone("successor completed");
      assert.strictEqual(
        await successor,
        approved,
        "forwarded successor settles only through its own inline done call",
      );
      assert.equal(
        titleWrites.at(-1),
        "π - fixture",
        "forwarded settlement proves the original local id was cleared despite gate error B",
      );
      assertOnePromptEnd(bus, successorDetails.requestId);
    } finally {
      if (timersEnabled) mock.timers.reset();
      if (hadQueue) queueGlobals[queueKey] = previousQueue;
      else delete queueGlobals[queueKey];
    }
  }
  console.log(
    "PASS: built LocalUserAuthorizer ends original UI prompts on success/refusal/errors and production queue timeout without fabricating decisions",
  );
}
