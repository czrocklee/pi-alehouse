import assert from "node:assert/strict";
import test from "node:test";
import {
  clearControlsAtStart,
  registerClearCommand,
} from "../../dist/orchestration/runtime/clear-session.js";

const off = { name: "off", version: "off-v1", digest: "fixture" };
const settings = () => ({
  selection: { ...off },
  delegation: { mode: "manual", eagerness: "reserved" },
  controls: { beerMugs: true, borderLabels: false, childSkills: false },
});

function registration(capture = settings) {
  const commands = [];
  registerClearCommand(
    new Proxy(
      {
        registerCommand(name, options) {
          commands.push({ name, options });
        },
      },
      {
        get(target, key) {
          assert.equal(key, "registerCommand", `unexpected API access: ${String(key)}`);
          return target[key];
        },
      },
    ),
    capture,
  );
  assert.equal(commands.length, 1);
  return commands[0];
}

function context(newSession) {
  const calls = [];
  let stale = false;
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        assert.equal(stale, false, "old command context accessed after replacement began");
        assert.equal(key, "newSession", `unexpected context access: ${String(key)}`);
        return function (...args) {
          assert.equal(this, ctx);
          calls.push(args);
          stale = true;
          return newSession(...args);
        };
      },
    },
  );
  return { ctx, calls };
}

function assertReplacement(calls) {
  assert.equal(calls.length, 1, "one native new-session request, without idle wait or retries");
  assert.equal(calls[0].length, 1);
  assert.deepEqual(Object.keys(calls[0][0]), ["setup", "withSession"]);
  assert.equal(typeof calls[0][0].setup, "function");
  assert.equal(typeof calls[0][0].withSession, "function");
}

test("/clear seeds Off even if an enabled default exists, and detaches settings before replacement", async () => {
  const entries = [];
  const live = settings();
  const { ctx } = context(async ({ setup }) => {
    live.selection.name = "too-late";
    live.controls.beerMugs = false;
    await setup({
      appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    });
    return { cancelled: false };
  });
  const { name, options } = registration(() => live);
  assert.equal(name, "clear");
  await options.handler("", ctx);
  assert.deepEqual(
    entries.map((item) => item.customType),
    ["alehouse:preset-selection:v1", "alehouse:delegation-mode:v1", "alehouse:clear-controls:v1"],
  );
  assert.deepEqual(entries[0].data, { ...off, selected_at: entries[0].data.selected_at });
  const dest = { sessionManager: { getBranch: () => entries } };
  assert.deepEqual(clearControlsAtStart("new", dest), settings().controls);
  for (const reason of ["resume", "fork", "reload", "startup"])
    assert.equal(clearControlsAtStart(reason, dest), undefined);
  assert.equal(clearControlsAtStart("new", { sessionManager: { getBranch: () => [] } }), undefined);
});

test("new-session controls reject malformed or duplicate records without evaluating getters", () => {
  const controls = settings().controls;
  for (const records of [
    [controls, controls],
    [null],
    [{ ...controls, approval: "yolo" }],
    [Object.create(controls)],
    [{ ...controls, beerMugs: "yes" }],
    [
      {
        ...controls,
        get childSkills() {
          throw new Error("unexpected getter");
        },
      },
    ],
  ]) {
    const branch = records.map((data) => ({
      type: "custom",
      customType: "alehouse:clear-controls:v1",
      data,
    }));
    const ctx = { sessionManager: { getBranch: () => branch } };
    assert.throws(() => clearControlsAtStart("new", ctx), { code: "INVALID_CLEAR_CONTROLS" });
    assert.equal(clearControlsAtStart("resume", ctx), undefined);
  }
});

test("an unavailable snapshot refuses /clear before replacing the session", async () => {
  const { ctx, calls } = context(() => assert.fail("must not replace"));
  const { options } = registration(() => {
    throw new Error("not ready");
  });
  await assert.rejects(options.handler("", ctx), /not ready/);
  assert.equal(calls.length, 0);
});

for (const hasUI of [true, false])
  test(`only a successful replacement receives feedback on its fresh context (hasUI=${hasUI})`, async () => {
    const notices = [];
    const { ctx, calls } = context(async ({ withSession }) => {
      await withSession({
        hasUI,
        ui: {
          notify(...args) {
            assert(hasUI, "headless replacement must not use UI");
            notices.push(args);
          },
        },
      });
      return { cancelled: false };
    });
    assert.equal(await registration().options.handler("ignored arguments", ctx), undefined);
    assertReplacement(calls);
    assert.deepEqual(notices, hasUI ? [["✓ New session started", "info"]] : []);
  });

test("awaits replacement and its completion callback before returning", async () => {
  let finish;
  const replacement = new Promise((resolvePromise) => {
    finish = resolvePromise;
  });
  const { ctx, calls } = context(() => replacement);
  let completed = false;
  const pending = registration()
    .options.handler("", ctx)
    .then(() => {
      completed = true;
    });
  await Promise.resolve();
  assertReplacement(calls);
  assert.equal(completed, false);
  finish({ cancelled: false });
  await pending;
  assert.equal(completed, true);
  assertReplacement(calls);
});

test("cancellation is benign and does not fabricate a success notice", async () => {
  const { ctx, calls } = context(() => Promise.resolve({ cancelled: true }));
  assert.equal(await registration().options.handler("", ctx), undefined);
  assertReplacement(calls);
  // A cancelled native operation never invokes withSession; no old-context UI is available.
});

for (const kind of ["synchronous", "asynchronous"])
  test(`propagates ${kind} newSession errors without retry or stale context access`, async () => {
    const error = new Error("synthetic replacement failure");
    const { ctx, calls } = context(() => {
      if (kind === "synchronous") throw error;
      return Promise.reject(error);
    });
    await assert.rejects(registration().options.handler("", ctx), (actual) => actual === error);
    assertReplacement(calls);
  });
