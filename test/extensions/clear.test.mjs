// Offline source-extension tests: no host session, model, network or generated runtime.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: false,
  moduleCache: false,
  fsCache: false,
});
const { default: clear } = await jiti.import(
  resolve(import.meta.dirname, "../../src/extensions/clear.ts"),
);

function registration() {
  const commands = [];
  clear(
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
  assert.deepEqual(Object.keys(calls[0][0]), ["withSession"]);
  assert.equal(typeof calls[0][0].withSession, "function");
}

test("registers only /clear with its exact alias description", () => {
  const { name, options } = registration();
  assert.equal(name, "clear");
  assert.equal(options.description, "Start a new session (alias for /new)");
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
