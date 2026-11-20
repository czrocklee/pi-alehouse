import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { registerFastMode } from "../../dist/orchestration/runtime/fast-mode.js";
import { loadSpeedLimits } from "../../dist/orchestration/runtime/codex-speed-limits.js";
import { providerRequestExtension } from "../../dist/orchestration/runtime/provider-requests.js";

const codex = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6.2-sol" };
const payload = Object.freeze({ model: codex.id, reasoning: Object.freeze({ effort: "high" }) });

const agentDir = mkdtempSync(join(tmpdir(), "alehouse-speed-fixture-"));
after(() => rmSync(agentDir, { recursive: true, force: true }));
writeFileSync(
  join(agentDir, "alehouse-codex-speeds.json"),
  JSON.stringify({
    [codex.id]: "fast",
    [`${codex.provider}/${codex.id}`]: "ultrafast",
    "gpt-6.2-astra": "fast",
  }),
);

function fixture(readLimits = () => loadSpeedLimits(agentDir)) {
  const commands = new Map(),
    parentHandlers = new Map(),
    childHandlers = new Map(),
    status = [],
    notices = [];
  const parent = {
    on: (name, handler) => parentHandlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  };
  const fast = registerFastMode(parent, readLimits);
  const extension = providerRequestExtension(fast.requestRule);
  extension(parent);
  extension({ on: (name, handler) => childHandlers.set(name, handler) });
  const ctx = {
    hasUI: true,
    model: codex,
    ui: { setStatus: (...args) => status.push(args), notify: (...args) => notices.push(args) },
  };
  parentHandlers.get("session_start")({}, ctx);
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
    glyphForModel: fast.glyphForModel,
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
  assert.deepEqual(fresh.status, [["alehouse-fast", undefined]]);
});

test("the model badge hides and returns without changing the shared Fast switch", async () => {
  const host = fixture();
  const secondary = { ...codex, provider: "openai-codex-2" };
  const mistral = { provider: "mistral", id: "mistral", api: "mistral-conversations" };
  host.selectModel(mistral);
  assert.equal(
    host.glyphForModel(() => assert.fail("Fast off must not resolve model metadata")),
    undefined,
  );
  await host.toggle();
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  assert.equal(
    host.glyphForModel(() => secondary),
    "⚡",
  );
  assert.equal(
    host.glyphForModel(() => mistral),
    undefined,
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
  await checkStatus(/Speed ceiling: Fast\. This model: Normal/);
  assert.deepEqual(host.status.at(-1), badge);
  assert.equal(host.childRequest(codex, payload).service_tier, "priority");
  await host.toggle("off status");
  assert.deepEqual(host.notices.at(-1), ["Usage: /fast [on|off|ultrafast|status]", "warning"]);
  assert.equal(host.childRequest(codex, payload).service_tier, "priority");
  await host.toggle("off");
  await host.toggle("off");
  await checkStatus(/^Fast is off/);
  assert.equal(host.childRequest(codex, payload), undefined);
});

test("cost reminders are conditional on a ceiling change, not a status query or a pricing table", async () => {
  const host = fixture();
  host.selectModel({ ...codex, api: "pi-virtual" }); // An eligible child still shares the ceiling.
  for (const [action, reminder] of [
    ["on", true],
    ["on", false],
    ["status", false],
    ["ultrafast", true],
    ["status", false],
    ["ultrafast", false],
    ["", false],
    ["", true],
    ["off", false],
  ]) {
    await host.toggle(action);
    const [notice] = host.notices.at(-1);
    assert.equal(notice.includes("included allowance"), reminder, `${action}: ${notice}`);
    assert.doesNotMatch(notice, /GPT-|\d\s*[x×]/i);
  }
  const normalOnly = fixture(() => ({ allowsAcceleration: false, limitFor: () => "normal" }));
  for (const action of ["on", "ultrafast", "status"]) {
    await normalOnly.toggle(action);
    assert.doesNotMatch(normalOnly.notices.at(-1)[0], /allowance/);
  }
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

test("Ultrafast is an explicit ceiling: match model and slot before sending, never promote", async () => {
  const host = fixture();
  const fastOnly = { ...codex, id: "gpt-6.2-astra" };
  host.selectModel(fastOnly);
  await host.toggle("ultrafast");
  await host.toggle("ultrafast");
  assert.doesNotMatch(host.notices.at(-1)[0], /allowance/);
  assert.match(host.notices.at(-1)[0], /Speed ceiling: Ultrafast\. This model: Fast\./);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡"]);
  assert.equal(host.parentRequest(fastOnly, { model: fastOnly.id }).service_tier, "priority");
  for (const id of [codex.id, fastOnly.id]) {
    const child = { ...codex, provider: "openai-codex-2", id };
    assert.equal(
      host.glyphForModel(() => child),
      "⚡",
    );
    assert.equal(host.childRequest(child, { model: id }).service_tier, "priority");
  }
  for (const model of [
    undefined,
    { ...codex, api: "pi-virtual" },
    { ...codex, provider: "openai" },
    { ...codex, id: "gpt-new" },
  ]) {
    assert.equal(
      host.glyphForModel(() => model),
      undefined,
    );
    assert.equal(host.childRequest(model, { model: model?.id }), undefined);
  }
  host.selectModel(codex);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡⚡"]);
  const count = host.status.length;
  await host.toggle("status");
  assert.match(host.notices.at(-1)[0], /Speed ceiling: Ultrafast\. This model: Ultrafast\./);
  assert.equal(host.status.length, count);
  for (const service_tier of [null, "default", "priority", "ultrafast", "flex"]) {
    assert.equal(host.parentRequest(codex, Object.freeze({ ...payload, service_tier })), undefined);
  }
  assert.equal(host.parentRequest(codex, { ...payload, model: "other" }), undefined);
  assert.deepEqual(host.parentRequest(codex, { ...payload, service_tier: undefined }), {
    ...payload,
    service_tier: "ultrafast",
  });
  await host.toggle("on");
  assert.equal(host.parentRequest(codex, payload).service_tier, "priority");
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", "⚡"]);
  await host.toggle("ultrafast");
  await host.toggle();
  assert.equal(host.childRequest(codex, payload), undefined, "bare /fast can leave Ultrafast");
  await host.toggle();
  assert.equal(
    host.childRequest(codex, payload).service_tier,
    "priority",
    "bare /fast never restores Ultrafast",
  );
  await host.toggle("ultrafast");
  host.start();
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  assert.equal(host.childRequest(codex, payload), undefined);
});

test("limits are sampled once per session; a failed reload clears the prior grant", async () => {
  let reads = 0;
  const host = fixture(() =>
    ++reads === 1
      ? loadSpeedLimits(agentDir)
      : { allowsAcceleration: false, limitFor: () => "normal", warning: "Invalid speed limits." },
  );
  await host.toggle("ultrafast");
  assert.equal(host.parentRequest(codex, payload).service_tier, "ultrafast");
  await host.toggle("status");
  assert.equal(reads, 1);
  host.start();
  assert.equal(reads, 2);
  assert.deepEqual(host.notices.at(-1), ["Invalid speed limits.", "warning"]);
  await host.toggle("ultrafast");
  assert.match(host.notices.at(-1)[0], /This model: Normal/);
  assert.equal(host.notices.at(-1)[1], "warning");
  assert.equal(host.childRequest(codex, payload), undefined);
  assert.deepEqual(host.status.at(-1), ["alehouse-fast", undefined]);
  assert.equal(reads, 2);
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
