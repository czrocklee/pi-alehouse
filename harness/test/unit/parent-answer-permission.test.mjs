import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// Exercise current source without writing or trusting a shared build tree.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { requireParentAnswerPermission } = await jiti.import(
  "../../src/runtime/parent-answer-permission.ts",
);
const { HarnessError } = await jiti.import("../../src/core/ports.ts");
// The parent's own tool-call context, handed to its authority unchanged.
const ctx = { sessionManager: { getEntries: () => [] }, getSystemPrompt: () => "" };
const check = (service, context = ctx) => requireParentAnswerPermission(service, context);
const exactQuery = (args) => {
  assert.equal(args.length, 2);
  assert.equal(args[0], "agent_answer");
  assert.equal(args[1], ctx);
};

function refusal(reason) {
  return (error) => {
    assert(error instanceof HarnessError);
    assert.equal(error.code, "RETURN_TO_PERMISSION_DENIED");
    assert.deepEqual(Object.keys(error.details).sort(), ["key", "reason", "resolution", "surface"]);
    assert.equal(error.details.key, "return_to");
    assert.equal(error.details.surface, "agent_answer");
    assert.equal(error.details.reason, reason);
    assert(Buffer.byteLength(JSON.stringify(error.details)) < 400);
    if (reason === "deny") assert.match(error.details.resolution, /report the denial/);
    else assert.match(error.details.resolution, /separate agent_spawn and agent_answer calls/);
    return true;
  };
}

test("effective parent allow is the authority's own synchronous tool-call decision, queried once", () => {
  let calls = 0;
  const service = {
    checkToolCallPermission(...args) {
      assert.equal(this, service);
      exactQuery(args);
      calls++;
      return { state: "allow", source: "session", origin: "session" };
    },
    getToolPermission() {
      assert.fail("blanket tool policy is not effective permission");
    },
    registerAuthorizer() {
      assert.fail("a lookup must never register an authority");
    },
  };
  assert.equal(check(service), undefined);
  assert.equal(calls, 1);
});

for (const state of ["deny", "ask", "unknown"])
  test(`effective ${state} rejects without another authority or grant`, () => {
    let calls = 0;
    const service = {
      checkToolCallPermission(...args) {
        calls++;
        exactQuery(args);
        return { state, reason: "PRIVATE_POLICY_REASON" };
      },
      getToolPermission() {
        assert.fail("do not replace a selected result with a blanket allow");
      },
      registerAuthorizer() {
        assert.fail("no prompting or grant registration");
      },
    };
    assert.throws(() => check(service), refusal(state));
    assert.equal(calls, 1);
  });

test("every call checks freshly; prior allow cannot hide a selected deny", () => {
  let state = "allow";
  const service = { checkToolCallPermission: () => ({ state }) };
  check(service);
  state = "deny";
  assert.throws(() => check(service), refusal("deny"));
});

for (const [name, state] of [
  ["missing", undefined],
  ["null", null],
  ["uppercase", "ALLOW"],
  ["future", "approved"],
  ["boolean", true],
  ["array", ["allow"]],
  ["boxed", new String("allow")],
  [
    "coercible",
    {
      toString() {
        assert.fail("never coerce permission state");
      },
    },
  ],
])
  test(`unrecognized state ${name} cannot become allow`, () => {
    assert.throws(() => check({ checkToolCallPermission: () => ({ state }) }), refusal("unknown"));
  });

for (const [name, result] of [
  ["absent", undefined],
  ["null", null],
  ["primitive", "allow"],
  ["array", Object.assign([], { state: "allow" })],
  ["promise", Promise.resolve({ state: "allow" })],
  [
    "thenable",
    {
      state: "allow",
      then() {
        assert.fail("do not call then");
      },
    },
  ],
  ["then property", { state: "allow", then: undefined }],
  [
    "inherited then",
    Object.assign(
      Object.create({
        then() {
          assert.fail("do not call inherited then");
        },
      }),
      { state: "allow" },
    ),
  ],
])
  test(`invalid synchronous result ${name} fails closed`, () => {
    assert.throws(() => check({ checkToolCallPermission: () => result }), refusal("unavailable"));
  });

for (const [name, service] of [
  ["absent", undefined],
  ["null", null],
  ["primitive", "allow"],
  ["empty", {}],
  ["invalid method", { checkToolCallPermission: "allow" }],
  [
    "array",
    Object.assign([], {
      checkToolCallPermission() {
        assert.fail("invalid service");
      },
    }),
  ],
  ["promise", Promise.resolve({ checkToolCallPermission: () => ({ state: "allow" }) })],
  [
    "thenable",
    {
      then() {
        assert.fail("do not await a service");
      },
      checkToolCallPermission() {
        assert.fail("invalid service");
      },
    },
  ],
])
  test(`unavailable service ${name} fails closed`, () => {
    assert.throws(() => check(service), refusal("unavailable"));
  });

for (const location of ["service", "query result"])
  for (const shadowThen of [false, true]) {
    test(`rejected native Promise ${location}${shadowThen ? " with shadowed then" : ""} is refused without an unhandled rejection`, async () => {
      let thenReads = 0;
      // Create rejection lazily in the active test, never during test discovery.
      const rejected = () => {
        const promise = Promise.reject(new Error("PRIVATE_ASYNC_PERMISSION_ERROR"));
        if (shadowThen)
          Object.defineProperty(promise, "then", {
            get() {
              thenReads++;
              throw new Error("DO_NOT_READ_THEN");
            },
          });
        return promise;
      };
      const service = location === "service" ? rejected() : { checkToolCallPermission: rejected };
      assert.throws(() => check(service), refusal("unavailable"));
      // Node's test runner reports an unhandled rejection before this turn ends.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(thenReads, 0, "the intrinsic sink must not read a shadowed then");
    });
  }

test("native rejection sink never invokes arbitrary service or result thenables", () => {
  let thenCalls = 0;
  const thenable = {
    state: "allow",
    then() {
      thenCalls++;
    },
  };
  assert.throws(
    () => check({ ...thenable, checkToolCallPermission: () => ({ state: "allow" }) }),
    refusal("unavailable"),
  );
  assert.throws(() => check({ checkToolCallPermission: () => thenable }), refusal("unavailable"));
  assert.equal(thenCalls, 0);
});

for (const [name, service] of [
  [
    "lookup throws",
    {
      checkToolCallPermission() {
        throw new Error("PRIVATE_SERVICE_ERROR");
      },
    },
  ],
  [
    "method getter throws",
    {
      get checkToolCallPermission() {
        throw new Error("PRIVATE_METHOD_ERROR");
      },
    },
  ],
  [
    "state getter throws",
    {
      checkToolCallPermission: () => ({
        get state() {
          throw new Error("PRIVATE_STATE_ERROR");
        },
      }),
    },
  ],
  [
    "service proxy throws",
    new Proxy(
      {},
      {
        has() {
          throw new Error("PRIVATE_PROXY_ERROR");
        },
      },
    ),
  ],
  [
    "result proxy throws",
    {
      checkToolCallPermission: () =>
        new Proxy(
          {},
          {
            has() {
              throw new Error("PRIVATE_RESULT_ERROR");
            },
          },
        ),
    },
  ],
])
  test(`${name} returns only bounded unavailable details`, () => {
    assert.throws(() => check(service), refusal("unavailable"));
  });

test("the authority binds the principal: the helper passes the context unread and never queries a principal itself", () => {
  const opaque = new Proxy(
    {},
    {
      get() {
        assert.fail("the helper must not read the parent context");
      },
      has() {
        assert.fail("the helper must not inspect the parent context");
      },
    },
  );
  let seen;
  const service = {
    checkToolCallPermission(name, context) {
      seen = context;
      assert.equal(name, "agent_answer");
      return { state: "allow" };
    },
    checkPermission() {
      assert.fail("an unbound principal query is not the gate decision");
    },
  };
  assert.equal(requireParentAnswerPermission(service, opaque), undefined);
  assert.equal(seen, opaque);
});

test("an authority without the tool-call decision fails closed instead of guessing the principal", () => {
  const service = {
    checkPermission() {
      assert.fail("never fall back to an unbound query");
      return { state: "allow" };
    },
  };
  assert.throws(() => check(service), refusal("unavailable"));
});

for (const [name, context] of [
  ["missing", undefined],
  ["null", null],
  ["primitive", "parent"],
])
  test(`a ${name} parent context fails closed without a query`, () => {
    const service = {
      checkToolCallPermission() {
        assert.fail("no query without the parent's context");
      },
    };
    assert.throws(() => requireParentAnswerPermission(service, context), refusal("unavailable"));
  });
