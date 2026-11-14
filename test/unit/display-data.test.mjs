import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const {
  DISPLAY_MARKERS: M,
  ownDisplayValue,
  copyDisplayData,
} = await jiti.import("../../src/orchestration/presentation/display-data.ts");
const { toolArgumentText } = await jiti.import(
  "../../src/orchestration/presentation/tool-argument-text.ts",
);

function hiddenObject(count) {
  const object = {};
  for (let index = 0; index < count; index++)
    Object.defineProperty(object, `hidden${index}`, { value: index });
  return object;
}

test("display marker spellings are stable", () => {
  assert.deepEqual(M, {
    elided: "[elided]",
    malformed: "[unrenderable]",
    accessor: "[accessor property]",
    callable: "[callable value]",
    circular: "[circular reference]",
    repeated: "[repeated reference]",
    ambiguous: "[ambiguous object keys]",
  });
});

test("ordinary JSON trees detach completely, preserving strings, keys and __proto__", () => {
  const source = JSON.parse('{"__proto__":{"safe":[{"text":"literal"}]},"list":[1,null]}');
  source["\x1b[command"] = "\x1b]payload\n\t\u00a0";
  const output = copyDisplayData(source);
  assert.deepEqual(output, source);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert(Object.hasOwn(output, "__proto__"));
  output.__proto__.safe[0].text = "changed";
  output.list.push(2);
  assert.equal(source.__proto__.safe[0].text, "literal");
  assert.deepEqual(source.list, [1, null]);
});

test("argument encoding applies to keys and strings without stripping or colliding", () => {
  const source = {
    command: "\x1b[123; echo actual\t\u00a0",
    "\x1b[command": "other",
    "\\x1b[command": "literal",
    nested: ["\x1b]0;payload\x07tail"],
  };
  assert.deepEqual(copyDisplayData(source, { text: toolArgumentText }), {
    command: "\\x1b[123; echo actual\\x09\u00a0",
    "\\x1b[command": "other",
    "\\\\x1b[command": "literal",
    nested: ["\\x1b]0;payload\\x07tail"],
  });
  assert.equal(source.command, "\x1b[123; echo actual\t\u00a0");
});

test("accessors, callable values and toJSON never execute, including array elements", () => {
  let getters = 0;
  let calls = 0;
  const source = {
    get unsafe() {
      getters++;
      throw new Error("must not run");
    },
    toJSON() {
      calls++;
      throw new Error("must not run");
    },
    okay: 1,
  };
  const array = new Array(3);
  Object.defineProperty(array, "1", { get: () => getters++ });
  array[2] = source;
  assert.equal(ownDisplayValue(source, "unsafe"), M.accessor);
  assert.equal(ownDisplayValue(Object.create({ inherited: 1 }), "inherited"), undefined);
  const output = copyDisplayData(array);
  assert.equal(output.length, 3);
  assert.equal(Object.hasOwn(output, 0), false, "a hole stays a hole");
  assert.equal(output[1], M.accessor);
  assert.deepEqual(output[2], { unsafe: M.accessor, toJSON: M.callable, okay: 1 });
  assert.equal(
    copyDisplayData(() => calls++),
    M.callable,
  );
  assert.equal(getters, 0);
  assert.equal(calls, 0);
});

test("ancestor cycles and globally repeated aliases have different markers", () => {
  let enumerations = 0;
  const shared = new Proxy(
    { child: { okay: 1 } },
    {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    },
  );
  const source = { first: shared, aliases: Array(100).fill(shared) };
  source.self = source;
  assert.deepEqual(copyDisplayData(source), {
    first: { child: { okay: 1 } },
    aliases: Array(100).fill(M.repeated),
    self: M.circular,
  });
  assert.equal(enumerations, 1, "the shared subtree is enumerated only once");
  const cycle = [];
  cycle.push(cycle);
  assert.deepEqual(copyDisplayData(cycle), [M.circular]);
});

test("descriptor and enumeration failures affect only their local property/subtree", () => {
  const source = new Proxy(
    { bad: 1, okay: 2 },
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "bad") throw new Error("descriptor");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  assert.equal(ownDisplayValue(source, "bad"), M.malformed);
  assert.deepEqual(copyDisplayData(source), { bad: M.malformed, okay: 2 });
  assert.deepEqual(copyDisplayData(source, { text: (text) => text.toUpperCase() }), {
    BAD: M.malformed,
    OKAY: 2,
  });
  const badEnumeration = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("keys");
      },
    },
  );
  assert.deepEqual(copyDisplayData({ badEnumeration, okay: { value: 3 } }), {
    badEnumeration: M.malformed,
    okay: { value: 3 },
  });
  const array = new Proxy([1, 2], {
    getOwnPropertyDescriptor(target, key) {
      if (key === "0") throw new Error("element");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(copyDisplayData(array), [M.malformed, 2]);
  const badLength = new Proxy([], {
    getOwnPropertyDescriptor() {
      throw new Error("length");
    },
  });
  assert.equal(copyDisplayData(badLength), M.malformed);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(copyDisplayData({ revoked: revoked.proxy, okay: 4 }), {
    revoked: M.malformed,
    okay: 4,
  });
});

test("hidden properties consume the explicit work budget before descriptor filtering", () => {
  let checks = 0;
  const source = new Proxy(hiddenObject(20_005), {
    getOwnPropertyDescriptor(target, key) {
      checks++;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.deepEqual(copyDisplayData(source), { hidden19999: M.elided });
  assert.equal(checks, 19_999, "root plus hidden checks exhaust 20000 units");
});

test("exhaustion never enumerates or reads the next wide object", () => {
  let enumerations = 0;
  let descriptors = 0;
  const wide = new Proxy(
    { unvisited: 1 },
    {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        descriptors++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const output = copyDisplayData({ filler: hiddenObject(19_995), wide });
  assert.deepEqual(output, { filler: {}, wide: M.elided });
  assert.equal(enumerations, 0);
  assert.equal(descriptors, 0);
});

test("transformed key collisions return an ambiguous object, including budget markers", () => {
  assert.equal(
    copyDisplayData({ A: 1, a: 2 }, { text: (text) => text.toLowerCase() }),
    M.ambiguous,
  );
  const source = { first: 1 };
  Object.defineProperties(source, Object.getOwnPropertyDescriptors(hiddenObject(19_997)));
  source.last = 2;
  assert.equal(copyDisplayData(source, { text: () => "same" }), M.ambiguous);
  assert.deepEqual(
    copyDisplayData(
      { nested: { A: 1, a: 2 }, okay: 3 },
      {
        text: (text) => text.toLowerCase(),
      },
    ),
    { nested: M.ambiguous, okay: 3 },
  );
});

test("text option accessors and failures are safe markers, never invoked implicitly", () => {
  let getters = 0;
  const options = {
    get text() {
      getters++;
      return (text) => text;
    },
  };
  assert.equal(copyDisplayData("literal", options), M.malformed);
  assert.equal(getters, 0);
  assert.equal(copyDisplayData("literal", { text: 42 }), M.malformed);
  assert.equal(copyDisplayData("literal", { text: () => null }), M.malformed);
  assert.equal(
    copyDisplayData("literal", {
      text: () => {
        throw new Error("text");
      },
    }),
    M.malformed,
  );
  assert.deepEqual(
    copyDisplayData(
      { bad: "fail", okay: "fine" },
      {
        text: (text) => {
          if (text === "fail") throw new Error("value");
          return text;
        },
      },
    ),
    { bad: M.malformed, okay: "fine" },
  );
  assert.deepEqual(
    copyDisplayData(
      { bad: { fail: 1 }, okay: 2 },
      {
        text: (text) => {
          if (text === "fail") throw new Error("key");
          return text;
        },
      },
    ),
    { bad: M.malformed, okay: 2 },
  );
});

test("depth, array width and large strings follow structural rather than character bounds", () => {
  const source = {};
  let cursor = source;
  for (let depth = 0; depth < 25; depth++) cursor = cursor.next = {};
  cursor = copyDisplayData(source);
  for (let depth = 0; depth < 24; depth++) cursor = cursor.next;
  assert.equal(cursor, M.elided);
  const array = copyDisplayData(new Array(20_005));
  assert.equal(array.length, 19_999);
  assert.equal(array.at(-1), M.elided);
  const text = "x".repeat(30_000);
  assert.deepEqual(copyDisplayData({ text }), { text });
});
