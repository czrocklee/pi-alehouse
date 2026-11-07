// Jev registered harness checker theme. The entry initializes Pi/jiti/parser once and calls this in-process.
import assert from "node:assert/strict";
import { join } from "node:path";
let harnessSerial = 0;
export const nextHarnessSerial = () => ++harnessSerial;
export const defaultSystemPrompt = () => `<project_context>
<project_instructions path="/fixture/AGENTS.md">
# Safety
Do not expose credentials.
</project_instructions>
</project_context>`;

export function createRegisteredHarness(jevAutoApproval, authorizerName, offlineRuntime) {
  function registeredHarness({ withSignal = true, mode = "enforce", hasUI = true } = {}) {
    const hooks = new Map();
    const bus = new Map();
    const reviews = [];
    const branch = [];
    const statuses = [],
      notices = [];
    const published = [];
    const reads = { systemPrompt: 0, branch: 0, policy: 0 };
    const sessionId = `jev-offline-${++harnessSerial}`;
    let authorizer;
    let systemPrompt = defaultSystemPrompt();
    const pi = {
      on(name, fn) {
        hooks.set(name, fn);
      },
      events: {
        on(name, fn) {
          bus.set(name, fn);
        },
        // Recorded after dispatch, so a claim by the handler is visible.
        emit(name, data) {
          bus.get(name)?.(data);
          published.push({ name, data: { ...data } });
        },
      },
    };
    const service = {
      registerAuthorizer(name, fn) {
        assert.equal(name, authorizerName, "registered the rendered Jev authorizer name");
        authorizer = fn;
        return () => {};
      },
    };
    const abort = new AbortController();
    const ctx = {
      cwd: offlineRuntime,
      hasUI,
      ...(withSignal ? { signal: abort.signal } : {}),
      getSystemPrompt: () => {
        reads.systemPrompt++;
        return systemPrompt;
      },
      ui: {
        setStatus(key, value) {
          statuses.push([key, value]);
        },
        notify(message, level) {
          notices.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
        getHeader: () => ({}),
        getBranch: () => {
          reads.branch++;
          return branch;
        },
        getSessionFile: () => join(offlineRuntime, `${sessionId}.jsonl`),
      },
    };
    const previousMode = process.env.PI_JEV_APPROVAL_MODE;
    try {
      process.env.PI_JEV_APPROVAL_MODE = mode;
      jevAutoApproval(pi);
      hooks.get("session_start")({}, ctx);
    } finally {
      process.env.PI_JEV_APPROVAL_MODE = previousMode;
    }
    globalThis[Symbol.for("@gotgenes/pi-permission-system:session-services")] = new Map([
      [sessionId, service],
    ]);
    bus.get("permissions:ready")({ sessionId });
    assert.equal(
      typeof authorizer,
      "function",
      "rendered extension registered a callable authorizer",
    );

    // Pi before 1.2 sends no messageType on before_agent_start.
    const live = (text, { legacy = false } = {}) => {
      hooks.get("input")({ source: "interactive", text });
      hooks.get("before_agent_start")(
        legacy ? { prompt: text } : { messageType: "user", prompt: text },
      );
      const message = { role: "user", content: [{ type: "text", text }] };
      hooks.get("message_start")({ message });
      branch.push({ type: "message", message });
    };
    const untrustedUser = (text) => {
      hooks.get("input")({ source: "extension", text, streamingBehavior: "followUp" });
      const message = { role: "user", content: [{ type: "text", text }] };
      hooks.get("message_start")({ message });
      branch.push({ type: "message", message });
    };
    const call = (id, command = "git status", extraArguments = {}, gate = {}) => {
      const arguments_ = { command, ...extraArguments };
      const message = {
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: arguments_ }],
      };
      branch.push({ type: "message", message });
      return {
        requestId: `request-${sessionId}-${id}`,
        source: "tool_call",
        toolCallId: id,
        payload: {
          kind: "bash",
          evidence: gate.evidence ?? [],
          request: {
            surface: "bash",
            toolName: "bash",
            invokedToolName: "bash",
            value: gate.value ?? command,
            matchedPattern: gate.matchedPattern ?? "bash:*",
            commandContext: gate.commandContext ?? null,
            executedUnit: gate.executedUnit ?? null,
            requester: { forwarded: false },
          },
        },
      };
    };
    const queryState = { value: "ask" };
    const query = {
      checkPermission: () => {
        reads.policy++;
        return {
          state: queryState.value,
          source: "bash",
          origin: "global",
          matchedPattern: "bash:*",
        };
      },
    };
    const log = {
      review(_event, detail) {
        reviews.push(detail);
      },
    };
    return {
      hooks,
      bus,
      branch,
      ctx,
      abort,
      reviews,
      live,
      untrustedUser,
      call,
      query,
      queryState,
      statuses,
      published,
      notices,
      reads,
      setMode: (mode, includeSubagents) => {
        const request = { mode, includeSubagents, applied: false };
        bus.get("approval:set-judge")(request);
        return request.applied;
      },
      authorize: (details) => authorizer(details, query, log),
      decide: (details, result, resolution) =>
        bus.get("permissions:decision")({
          requestId: details.requestId,
          result,
          resolution,
        }),
      setSystemPrompt(value) {
        systemPrompt = value;
      },
    };
  }

  return registeredHarness;
}
