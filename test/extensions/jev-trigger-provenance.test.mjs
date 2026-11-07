// Source-level denial-fuse trigger regressions for the Jev authorizer. The
// unrendered source extension is loaded through jiti against the pinned
// development SDK: no build, generated runtime, credentials, network, real
// model or human approval. The reviewer transport is a mocked fetch, the
// audit sink is an isolated offline fixture directory, and every permission
// ask is synthetic. Only the fuse/pause reopening discipline is asserted: the
// denial fuse reopens on the provenance-bound actual message, never on a
// before_agent_start label, and unsupported event shapes stay fail-closed
// with one prompt-free diagnostic per session.
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { createJevFixture } from "../../scripts/checks/jev-fixture.mjs";
import { allowAnswers, mockResponse } from "../../scripts/checks/jev-wire.mjs";
import { resolveFlock } from "../../bin/runtime-support.mjs";

const scratch = mkdtempSync(join(tmpdir(), "jev-trigger-provenance-"));
for (const name of ["home", "config", "state", "cache"])
  mkdirSync(join(scratch, name), { mode: 0o700 });
Object.assign(process.env, {
  HOME: join(scratch, "home"),
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_STATE_HOME: join(scratch, "state"),
  XDG_CACHE_HOME: join(scratch, "cache"),
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
});
process.env.PI_ALEHOUSE_FLOCK = resolveFlock();
const agentDir = join(scratch, "agent");
mkdirSync(join(agentDir, "logs"), { recursive: true, mode: 0o700 });
process.env.PI_CODING_AGENT_DIR = agentDir;
const keyFile = join(scratch, "mock-key");
writeFileSync(keyFile, "offline-test-key-not-a-credential\n", { mode: 0o600 });
process.env.PI_JEV_API_KEY_FILE = keyFile;
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
globalThis.fetch = async () => {
  throw new Error("Network disabled in source-level trigger regressions");
};

const extensionPath = fileURLToPath(
  new URL("../../src/extensions/jev-auto-approval.ts", import.meta.url),
);
const jiti = createJiti(import.meta.url, { fsCache: false });
const { default: jevAutoApproval } = await jiti.import(extensionPath);
const authorizerName = /^const AUTHORIZER_NAME = "([^"]+)";$/m.exec(
  readFileSync(extensionPath, "utf8"),
)?.[1];
assert.equal(authorizerName, "jev-model-judge", "pinned source authorizer name");
const offlineRuntime = join(scratch, "runtime");
mkdirSync(offlineRuntime, { mode: 0o700 });
const registeredFixture = createJevFixture(jevAutoApproval, authorizerName, offlineRuntime);
const auditPath = join(agentDir, "logs", "jev-auto-approval.jsonl");
const unsupportedAudits = () =>
  readFileSync(auditPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.event === "jev_model_judge.unsupported_start_event");
const denyAnswers = () => ({ ...allowAnswers(), injection: { noul: 0.99 } });

test("only provenance-bound direct input reopens the reviewer denial fuse", async () => {
  const h = registeredFixture();
  h.live("Inspect three independent status targets.");
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(denyAnswers());
  };
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await h.authorize(h.call(`fused-${i}`, `git status -- fused-${i}`))).kind,
      "deny",
      `reviewer denial ${i} counts toward the fuse`,
    );

  // A user-tagged start from an extension (pi.sendUserMessage) is a message
  // type, not human origin: even with its actual message it reopens nothing.
  h.extensionUser("Extension generated follow-up");
  assert.equal((await h.authorize(h.call("fused-ext", "git status -- fused-ext"))).kind, "deny");
  assert.equal(h.reviews.at(-1).reasonCode, "refusal_fuse");
  assert.equal(fetchCalls, 3, "the fused request never reached the model");

  // Pending live input that never becomes the actual message reopens nothing.
  h.hooks.get("input")({ source: "interactive", text: "Authorize a fresh inspection now." });
  h.hooks.get("before_agent_start")({
    messageType: "user",
    prompt: "Authorize a fresh inspection now.",
  });
  assert.equal(
    (await h.authorize(h.call("fused-unsubmitted", "git status -- fused-unsubmitted"))).kind,
    "deny",
  );
  assert.equal(h.reviews.at(-1).reasonCode, "refusal_fuse");

  // A bound start whose actual message arrives rewritten reopens nothing.
  h.hooks.get("input")({ source: "interactive", text: "Typed exact input" });
  h.hooks.get("before_agent_start")({ messageType: "user", prompt: "Typed exact input" });
  h.hooks.get("message_start")({
    message: { role: "user", content: [{ type: "text", text: "Rewritten by a handler" }] },
  });
  assert.equal(
    (await h.authorize(h.call("fused-mismatch", "git status -- fused-mismatch"))).kind,
    "deny",
  );
  assert.equal(h.reviews.at(-1).reasonCode, "refusal_fuse");
  assert.equal(fetchCalls, 3, "no fused request reached the model");

  // The actual current direct input reopens the fuse: the reviewer is
  // consulted again and may allow.
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(allowAnswers());
  };
  h.live("Authorize a fresh inspection after the refusals.");
  assert.equal(
    (await h.authorize(h.call("fused-reopened", "git status -- reopened"))).kind,
    "allow",
  );
  assert.equal(fetchCalls, 4);
});

test("custom, missing and unknown starts keep the fuse and recorded human pauses", async () => {
  const h = registeredFixture();
  h.live("Inspect one status target, then refuse one.");
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(allowAnswers());
  };
  const paused = h.call("paused-action", "git status -- paused-target");
  assert.equal((await h.authorize(paused)).kind, "allow");
  h.decide(paused, "deny", "user_denied");
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(denyAnswers());
  };
  for (let i = 0; i < 3; i++)
    assert.equal(
      (await h.authorize(h.call(`fused-${i}`, `git status -- fused-${i}`))).kind,
      "deny",
    );

  for (const [name, start] of [
    [
      "custom",
      {
        messageType: "custom",
        message: { role: "custom", customType: "fixture", content: "ready" },
      },
    ],
    ["missing", { prompt: "Fresh direct input" }],
    ["unknown", { messageType: "fixture-unknown", prompt: "Fresh direct input" }],
  ]) {
    h.hooks.get("before_agent_start")(start);
    assert.equal(
      (await h.authorize(h.call(`after-${name}`, `git status -- after-${name}`))).kind,
      "deny",
    );
    assert.equal(h.reviews.at(-1).reasonCode, "refusal_fuse", `${name} start keeps the fuse`);
    assert.equal(
      (await h.authorize(h.call(`retry-${name}`, "git status -- paused-target"))).kind,
      "deny",
    );
    assert.equal(
      h.reviews.at(-1).reasonCode,
      "approval_retry_paused",
      `${name} start keeps the human pause`,
    );
  }
  assert.equal(fetchCalls, 4, "no fused or paused retry reached the model");

  // Real direct input clears both the pause and the fuse.
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(allowAnswers());
  };
  h.live("Authorize a fresh inspection after the refusals.");
  assert.equal(
    (await h.authorize(h.call("pause-cleared", "git status -- paused-target"))).kind,
    "allow",
  );
  assert.equal(fetchCalls, 5);
});

test("unsupported start shapes draw one prompt-free session diagnostic", async () => {
  const h = registeredFixture();
  const before = unsupportedAudits().length;
  const marker = "diagnostic-prompt-marker-must-not-appear";
  h.hooks.get("before_agent_start")({ prompt: marker, systemPrompt: "Loaded instructions" });
  h.hooks.get("before_agent_start")({ messageType: "user", systemPrompt: "Loaded instructions" });
  h.hooks.get("before_agent_start")({ messageType: "fixture-unknown", prompt: marker });
  // A custom-message run is a legitimate non-human start: never diagnosed.
  h.hooks.get("before_agent_start")({
    messageType: "custom",
    message: { role: "custom", customType: "fixture", content: "ready" },
  });
  assert.equal(h.notices.length, 1, "one warning across the unsupported shapes");
  assert.equal(h.notices[0].level, "warning");
  assert(h.notices[0].message.includes("before_agent_start"));
  assert(!h.notices[0].message.includes(marker), "the warning never carries prompt text");
  const added = unsupportedAudits().slice(before);
  assert.equal(added.length, 1, "the audit diagnostic is deduplicated per session");
  assert.equal(added[0].reason, "missing_message_type");
  assert.equal(added[0].scope, "session");
  assert(!JSON.stringify(added).includes(marker), "the audit line never carries prompt text");

  // Fail closed: the malformed starts bound no live input, so the next user
  // message stays unverified history and no permission was granted.
  h.hooks.get("input")({ source: "interactive", text: "Typed live input" });
  h.hooks.get("before_agent_start")({ prompt: "Typed live input" });
  const unbound = { role: "user", content: [{ type: "text", text: "Typed live input" }] };
  h.hooks.get("message_start")({ message: unbound });
  h.branch.push({ type: "message", message: unbound });
  assert.equal((await h.authorize(h.call("unbound-live"))).kind, "defer");
  assert.equal(h.reviews.at(-1).reasonCode, "context_incomplete");

  // A real direct input still works and draws no further diagnostic.
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return mockResponse(allowAnswers());
  };
  h.live("Inspect the fixture after the malformed starts.");
  assert.equal((await h.authorize(h.call("after-malformed"))).kind, "allow");
  assert.equal(fetchCalls, 1);
  assert.equal(h.notices.length, 1, "the diagnostic fires once per session");
  assert.equal(unsupportedAudits().length, before + 1);
});

test("child witness diagnostics are vocabulary-gated and owner-bound", () => {
  const h = registeredFixture();
  const runtimeKey = Symbol.for("@rocklee/jev-auto-approval:child-runtime-facts");
  const parentSessionId = h.ctx.sessionManager.getSessionId();
  const childSession = "child-session-fixture";
  const secret = "SECRET-REASON-PAYLOAD-must-not-appear";
  const facts = (owner = parentSessionId) => ({
    parentSessionId: owner,
    cwd: offlineRuntime,
    contextChanged: false,
    toolCalls: {},
    requestTools: {},
    delegation: { owner_id: owner, generation: "g", agent_id: "a", run_id: "r" },
  });
  globalThis[runtimeKey] = new Map([[childSession, facts()]]);
  const witnessInvalidated = (payload) =>
    h.bus.get("pi-alehouse:approval:witness-invalidated")(payload);
  try {
    const before = unsupportedAudits().length;
    // An unknown or arbitrary reason string is ignored outright: no log, no
    // toast, and the one-time child quota is not consumed.
    witnessInvalidated({ sessionId: childSession, reason: secret });
    witnessInvalidated({ sessionId: childSession, reason: "missing_message_type " });
    witnessInvalidated({ sessionId: childSession });
    witnessInvalidated({ reason: "missing_message_type" });
    assert.equal(h.notices.length, 0, "no warning for unknown or partial reports");
    assert.equal(unsupportedAudits().length, before, "no audit line for unknown reasons");

    // Another session's report cannot spend this session's one-time warning.
    witnessInvalidated({ sessionId: "other-session", reason: "missing_message_type" });
    globalThis[runtimeKey].set("foreign-owner", facts("another-owner"));
    witnessInvalidated({ sessionId: "foreign-owner", reason: "missing_message_type" });
    // Stale or mismatched runtime facts are not this session's witness.
    globalThis[runtimeKey].set("mixed-owner", {
      ...facts(),
      delegation: { ...facts().delegation, owner_id: "another-owner" },
    });
    witnessInvalidated({ sessionId: "mixed-owner", reason: "missing_message_type" });
    globalThis[runtimeKey].set("mixed-parent", {
      ...facts("another-owner"),
      delegation: facts().delegation,
    });
    witnessInvalidated({ sessionId: "mixed-parent", reason: "missing_message_type" });
    globalThis[runtimeKey].delete(childSession);
    witnessInvalidated({ sessionId: childSession, reason: "missing_message_type" });
    assert.equal(h.notices.length, 0, "no warning for foreign or stale witnesses");
    assert.equal(unsupportedAudits().length, before);

    // A legitimate report from this session's live witness still warns
    // exactly once, with fixed text only.
    globalThis[runtimeKey].set(childSession, facts());
    witnessInvalidated({ sessionId: childSession, reason: "missing_message_type" });
    assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0].level, "warning");
    assert(h.notices[0].message.includes("child session"));
    assert(!h.notices[0].message.includes(secret), "no arbitrary reason text is echoed");
    const added = unsupportedAudits().slice(before);
    assert.equal(added.length, 1);
    assert.equal(added[0].scope, "child_witness");
    assert.equal(added[0].reason, "missing_message_type");
    assert(!JSON.stringify(added).includes(secret));
    // Dedup: a second legitimate report stays silent and keeps the quota.
    witnessInvalidated({ sessionId: childSession, reason: "unknown_message_type" });
    assert.equal(h.notices.length, 1);
    assert.equal(unsupportedAudits().length, before + 1);
  } finally {
    delete globalThis[runtimeKey];
  }
});
