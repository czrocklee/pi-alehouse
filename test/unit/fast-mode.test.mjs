import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { registerFastMode } from "../../dist/orchestration/runtime/fast-mode.js";
import { providerRequestExtension } from "../../dist/orchestration/runtime/provider-requests.js";

const codex = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6.2-sol" };
const payload = Object.freeze({ model: codex.id, reasoning: Object.freeze({ effort: "high" }) });

function fixture() {
  const commands = new Map(),
    parentHandlers = new Map(),
    childHandlers = new Map(),
    status = [],
    notices = [];
  const parent = {
    on: (name, handler) => parentHandlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  const fast = registerFastMode(parent);
  const extension = providerRequestExtension(fast.requestRule);
  extension(parent);
  extension({ on: (name, handler) => childHandlers.set(name, handler) });
  const ctx = {
    hasUI: true,
    model: codex,
    ui: { setStatus: (...args) => status.push(args), notify: (...args) => notices.push(args) },
  };
  return {
    parentRequest: (model, body) =>
      parentHandlers.get("before_provider_request")({ payload: body }, { model }),
    childRequest: (model, body) =>
      childHandlers.get("before_provider_request")({ payload: body }, { model }),
    start: () => parentHandlers.get("session_start")({}, ctx),
    selectModel: (model) => {
      ctx.model = model;
      parentHandlers.get("model_select")({ model }, ctx);
    },
    toggle: (args = "") => commands.get("fast").handler(args, ctx),
    requestedForModel: fast.requestedForModel,
    childHandlers,
    status,
    notices,
  };
}

test("one parent switch drives the next requests in already-registered child and parent sessions", async () => {
  const host = fixture();
  const secondary = { ...codex, provider: "openai-codex-2" };
  assert.deepEqual([...host.childHandlers.keys()], ["before_provider_request"]);
  assert.equal(host.parentRequest(codex, payload), undefined);
  assert.equal(host.childRequest(secondary, payload), undefined);
  await host.toggle("bogus");
  assert.equal(host.parentRequest(codex, payload), undefined);
  await host.toggle();
  assert.deepEqual(host.parentRequest(codex, payload), { ...payload, service_tier: "priority" });
  assert.deepEqual(host.childRequest(secondary, payload), { ...payload, service_tier: "priority" });
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡"]);
  assert.equal(fixture().parentRequest(codex, payload), undefined, "another parent starts off");
  await host.toggle();
  assert.equal(host.childRequest(secondary, payload), undefined);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  await host.toggle();
  host.start();
  assert.equal(host.parentRequest(codex, payload), undefined);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  const fresh = fixture();
  fresh.start();
  assert.deepEqual(fresh.status, [["alehouse-fast", undefined]]);
});

test("the model badge hides and returns without changing the shared Fast switch", async () => {
  const host = fixture();
  const secondary = { ...codex, provider: "openai-codex-2" };
  const mistral = { provider: "mistral", id: "mistral", api: "mistral-conversations" };
  host.selectModel(mistral);
  assert.equal(
    host.requestedForModel(() => assert.fail("Fast off must not resolve model metadata")),
    false,
  );
  await host.toggle();
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  assert.equal(
    host.requestedForModel(() => secondary),
    true,
  );
  assert.equal(
    host.requestedForModel(() => mistral),
    false,
  );
  assert.equal(host.childRequest(secondary, payload).service_tier, "priority");
  host.selectModel(secondary);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡"]);
  for (const model of [mistral, { ...codex, id: "unsupported" }, { ...codex, api: "pi-virtual" }]) {
    host.selectModel(model);
    assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
    assert.equal(host.childRequest(secondary, payload).service_tier, "priority");
  }
  host.selectModel(codex);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡"]);
  await host.toggle();
  host.selectModel(secondary);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  assert.equal(host.childRequest(secondary, payload), undefined);
});

test("explicit Fast commands are idempotent and status works without the parent badge", async () => {
  const host = fixture();
  host.selectModel({ ...codex, api: "pi-virtual" });
  const badge = host.status.at(-1);
  assert.deepEqual(badge, ["alehouse-fast", undefined]);
  const checkStatus = async (expected) => {
    const count = host.status.length;
    await host.toggle("status");
    assert.match(host.notices.at(-1)[0], expected);
    assert.equal(host.notices.at(-1)[1], "info");
    assert.equal(host.status.length, count, "status does not repaint or change the switch");
  };
  await checkStatus(/^Fast is off/);
  await host.toggle(" on ");
  await host.toggle("on");
  await checkStatus(/^Fast is on/);
  assert.deepEqual(host.status.at(-1), badge);
  assert.equal(host.childRequest(codex, payload).service_tier, "priority");
  await host.toggle("off status");
  assert.deepEqual(host.notices.at(-1), ["Usage: /fast [on|off|status]", "warning"]);
  assert.equal(host.childRequest(codex, payload).service_tier, "priority");
  await host.toggle("off");
  await host.toggle("off");
  await checkStatus(/^Fast is off/);
  assert.equal(host.childRequest(codex, payload), undefined);
});

test("Fast is limited to supported Codex models and does not replace any explicit tier", async () => {
  const host = fixture();
  await host.toggle();
  for (const model of [
    undefined,
    { ...codex, api: "pi-virtual" },
    { ...codex, api: "openai-responses" },
    { ...codex, provider: "mistral", api: "mistral-conversations" },
    { ...codex, provider: "openai-codex-proxy" },
    { ...codex, id: "gpt-unsupported" },
    { ...codex, id: "gpt-5.4" },
    { ...codex, id: "gpt-5.5" },
    { ...codex, id: "codex-auto-review" },
  ]) {
    assert.equal(host.childRequest(model, { ...payload, model: model?.id }), undefined);
  }
  assert.deepEqual(host.childRequest(codex, { ...payload, service_tier: undefined }), {
    ...payload,
    service_tier: "priority",
  });
  for (const body of [
    undefined,
    null,
    [payload],
    { ...payload, model: "other-model" },
    { ...payload, service_tier: null },
    { ...payload, service_tier: "default" },
    { ...payload, service_tier: "flex" },
  ]) {
    assert.equal(host.childRequest(codex, body), undefined);
  }
});

test("Pi chains trusted request rules and isolates a failed rule without losing other rewrites", async () => {
  const handlers = new Map();
  providerRequestExtension(
    (model, body) => {
      assert.deepEqual(model, codex, "rules receive only model identity metadata");
      return { ...body, added: true };
    },
    () => {
      throw new Error("synthetic rule failure");
    },
    (_model, body) => {
      assert.equal(body.added, true);
      return undefined;
    },
    (_model, body) => ({ ...body, last: true }),
  )({ on: (name, callback) => handlers.set(name, [...(handlers.get(name) ?? []), callback]) });
  const model = { ...codex, headers: { Authorization: "not a credential" } };
  const errors = [];
  const replacement = await ExtensionRunner.prototype.emitBeforeProviderRequest.call(
    {
      createContext: () => ({ model }),
      extensions: [{ path: "fixture:provider-requests", handlers }],
      emitError: (error) => errors.push(error),
    },
    payload,
  );
  assert.deepEqual(replacement, { ...payload, added: true, last: true });
  assert.deepEqual(
    errors.map(({ event, error }) => [event, error]),
    [["before_provider_request", "synthetic rule failure"]],
  );
});
