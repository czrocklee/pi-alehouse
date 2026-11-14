import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { detachedToolResult } = await jiti.import(
  "../../src/orchestration/ui/tool-result-projection.ts",
);

test("result display envelopes detach all mutable data and retain literal strings", () => {
  const literal = "diff\n+你🚀\u001b[31m\u202e";
  const source = {
    role: "toolResult",
    toolCallId: "original",
    content: [
      { type: "text", text: literal },
      { type: "image", data: "YmluYXJ5", mimeType: "image/png" },
    ],
    details: { diff: literal, patch: literal, truncation: { truncated: true } },
    isError: true,
    durationMs: 19,
    execute() {
      assert.fail("result projection must never execute a tool");
    },
  };
  const copy = detachedToolResult(source);
  assert.deepEqual(Object.keys(copy).sort(), ["content", "details", "durationMs", "isError"]);
  assert.equal(copy.content[0].text, literal, "renderers, not the data copier, style result text");
  assert.equal(copy.content[1].data, "YmluYXJ5");
  assert.equal(copy.details.diff, literal);
  assert.equal(copy.details.patch, literal);
  assert.notEqual(copy.content, source.content);
  assert.notEqual(copy.content[0], source.content[0]);
  assert.notEqual(copy.details.truncation, source.details.truncation);
  copy.content[0].text = "renderer mutation";
  copy.content.push({ type: "text", text: "injected" });
  copy.details.truncation.truncated = false;
  assert.equal(source.content[0].text, literal);
  assert.equal(source.content.length, 2);
  assert.equal(source.details.truncation.truncated, true);
});

test("result accessors and callable values are marked without invocation", () => {
  let reads = 0;
  const details = {
    get secret() {
      reads++;
      throw new Error("a recorded getter is not render data");
    },
    callback() {
      assert.fail("callable data must not run");
    },
  };
  const source = { content: [{ type: "text", text: "safe body" }], details };
  const copy = detachedToolResult(source);
  assert.equal(reads, 0);
  assert.equal(copy.details.secret, "[accessor property]");
  assert.equal(copy.details.callback, "[callable value]");
  assert.equal(copy.content[0].text, "safe body");
  const accessorRoot = Object.defineProperty({}, "content", {
    enumerable: true,
    get() {
      reads++;
      return source.content;
    },
  });
  assert.equal(detachedToolResult(accessorRoot).content[0].text, "[accessor property]");
  assert.equal(reads, 0);
});

test("malformed result blocks are isolated without dropping valid neighbouring text", () => {
  const broken = new Proxy(
    {},
    {
      ownKeys: () => {
        throw new Error("broken record");
      },
    },
  );
  const source = {
    content: [{ type: "text", text: "before" }, broken, { type: "text", text: "after" }],
    details: { safe: 1 },
  };
  assert.deepEqual(
    detachedToolResult(source).content.map((part) => part.text),
    ["before", "[unrenderable]", "after"],
  );
  assert.equal(detachedToolResult({ content: null }).content[0].text, "[unrenderable]");
  assert.deepEqual(detachedToolResult({}).content, []);
});

test("cycles and __proto__ keys stay detached data, never prototypes", () => {
  const details = JSON.parse('{"__proto__":{"polluted":"no"},"safe":1}');
  details.self = details;
  const copy = detachedToolResult({ content: [], details });
  assert.equal(copy.details.self, "[circular reference]");
  assert.equal(Object.getPrototypeOf(copy.details), Object.prototype);
  assert.ok(Object.hasOwn(copy.details, "__proto__"));
  copy.details.__proto__.polluted = "changed copy";
  assert.equal(details.__proto__.polluted, "no");
  assert.equal({}.polluted, undefined);
});

test("large or deep details cannot consume the independent body budget", () => {
  const text = "recorded long text 你🚀\n".repeat(10_000);
  let deep = { text: "deep leaf" };
  for (let i = 0; i < 100; i++) deep = { child: deep };
  const details = { wide: Array.from({ length: 30_000 }, (_, i) => i), deep };
  const source = { content: [{ type: "text", text }], details };
  const copy = detachedToolResult(source);
  assert.equal(copy.content[0].text, text, "string leaves are not truncated by a node budget");
  assert.ok(JSON.stringify(copy.details).includes("[elided]"));
  const deepOnly = detachedToolResult({ content: [], details: deep });
  assert.ok(JSON.stringify(deepOnly.details).includes("[elided]"));
  assert.equal(details.wide.length, 30_000, "the recorded source stays intact");
});

test("display error and duration flags use own data without invoking getters", () => {
  let reads = 0;
  const source = { content: [], durationMs: Number.NaN };
  Object.defineProperty(source, "isError", {
    get() {
      reads++;
      return true;
    },
  });
  const copy = detachedToolResult(source);
  assert.equal(reads, 0);
  assert.equal(copy.isError, false);
  assert.ok(!Object.hasOwn(copy, "durationMs"));
  const error = detachedToolResult({ content: [], isError: true, durationMs: 0 });
  assert.equal(error.isError, true);
  assert.equal(error.durationMs, 0);
  const inherited = detachedToolResult(
    Object.assign(Object.create({ isError: true, durationMs: 5 }), { content: [] }),
  );
  assert.equal(inherited.isError, false);
  assert.ok(!Object.hasOwn(inherited, "durationMs"));
  for (const flag of [1, "true", {}, () => assert.fail("callable flag")]) {
    assert.equal(detachedToolResult({ isError: flag }).isError, false);
  }
  for (const durationMs of [Infinity, -Infinity, "5", null]) {
    assert.ok(!Object.hasOwn(detachedToolResult({ durationMs }), "durationMs"));
  }
  const accessorDuration = Object.defineProperty({}, "durationMs", {
    get() {
      return assert.fail("duration getter must not run");
    },
  });
  assert.ok(!Object.hasOwn(detachedToolResult(accessorDuration), "durationMs"));
});

test("JSON text/image extras and _meta cannot displace later IMPORTANT body text", () => {
  const extras = Object.fromEntries(Array.from({ length: 25_000 }, (_, i) => [`extra${i}`, i]));
  const imageData = "YmluYXJ5".repeat(30_000);
  for (const visual of [
    { type: "text", text: "first body" },
    { type: "image", data: imageData, mimeType: "image/png" },
  ]) {
    const first = JSON.parse(JSON.stringify({ ...visual, ...extras, _meta: extras }));
    const important = { type: "text", text: "IMPORTANT" };
    const source = { content: [first, important], details: { retained: "independent" } };
    const copy = detachedToolResult(source);
    assert.deepEqual(copy.content, [visual, important]);
    assert.deepEqual(copy.details, source.details);
    assert.notEqual(copy.content[0], first);
    assert.equal(Object.keys(first).length, 25_000 + Object.keys(visual).length + 1);
  }
});

test("visual-only blocks never enumerate or inspect extra fields, including SDK textSignature", () => {
  const touched = [];
  const guard = (visual, allowed) =>
    new Proxy(
      Object.defineProperties(visual, {
        _meta: {
          enumerable: true,
          get() {
            return assert.fail("extra getter must not run");
          },
        },
        extra: { enumerable: true, value: () => assert.fail("extra callable must not run") },
      }),
      {
        ownKeys() {
          assert.fail("visual block must not enumerate even one extra key");
        },
        get() {
          assert.fail("visual block reads require own data descriptors");
        },
        getOwnPropertyDescriptor(target, key) {
          assert.ok(allowed.includes(key), `unexpected field inspection: ${String(key)}`);
          touched.push(key);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
  // textSignature is legal SDK TextContent metadata, but is not a visual field.
  const text = guard({ type: "text", text: "literal", textSignature: "sdk-signature" }, [
    "type",
    "text",
  ]);
  const image = guard({ type: "image", data: "YmluYXJ5", mimeType: "image/png" }, [
    "type",
    "data",
    "mimeType",
  ]);
  const copy = detachedToolResult({ content: [text, image, text] });
  assert.deepEqual(copy.content, [
    { type: "text", text: "literal" },
    { type: "image", data: "YmluYXJ5", mimeType: "image/png" },
    { type: "text", text: "literal" },
  ]);
  assert.deepEqual(touched, ["type", "text", "type", "data", "mimeType", "type", "text"]);
  assert.ok(!Object.hasOwn(copy.content[0], "textSignature"));
  assert.notEqual(copy.content[0], copy.content[2], "reused source blocks detach independently");
});

test("body inspection budgets bound huge sparse and dense arrays without consuming details", () => {
  for (const visual of [
    undefined,
    { type: "text", text: "body" },
    { type: "image", data: "YmluYXJ5", mimeType: "image/png" },
  ]) {
    let inspections = 0;
    const block =
      visual &&
      new Proxy(visual, {
        getOwnPropertyDescriptor(target, key) {
          inspections++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    const content = new Proxy(new Array(1_000_000_000), {
      get() {
        assert.fail("content array reads require own data descriptors");
      },
      ownKeys() {
        assert.fail("content array must not enumerate its keys");
      },
      getOwnPropertyDescriptor(target, key) {
        inspections++;
        if (key === "length" || block === undefined) {
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
        return { configurable: true, enumerable: true, writable: true, value: block };
      },
    });
    const source = new Proxy(
      { content, details: { retained: "IMPORTANT details" } },
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "content") inspections++;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const copy = detachedToolResult(source);
    assert.equal(inspections, 20_000, "entry, length, and visual field inspections share one cap");
    assert.equal(copy.content.at(-1).text, "[elided]");
    assert.ok(copy.content.length <= 20_000);
    assert.deepEqual(copy.details, { retained: "IMPORTANT details" });
    if (visual) assert.deepEqual(copy.content[0], visual);
    else assert.equal(copy.content[0].text, "[unrenderable]");
  }
});

test("content descriptors isolate accessor, callable and damaged blocks from valid neighbours", () => {
  const callable = () => assert.fail("recorded callables are not display code");
  const accessor = (object, key) =>
    Object.defineProperty(object, key, {
      enumerable: true,
      get() {
        return assert.fail(`recorded ${key} getter must not run`);
      },
    });
  const damaged = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("damaged block descriptor");
      },
    },
  );
  const content = [
    { type: "text", text: "before" },
    damaged,
    accessor({}, "type"),
    accessor({ type: "text" }, "text"),
    accessor({ type: "image", mimeType: "image/png" }, "data"),
    accessor({ type: "image", data: "YmluYXJ5" }, "mimeType"),
    { type: "text", text: callable },
    callable,
    undefined,
    Object.create({ type: "text", text: "inherited body is not recorded own data" }),
    { type: "text", text: "after" },
  ];
  accessor(content, "8");
  assert.deepEqual(detachedToolResult({ content }).content, [
    { type: "text", text: "before" },
    { type: "text", text: "[unrenderable]" },
    { type: "text", text: "[unrenderable]" },
    { type: "text", text: "[accessor property]" },
    { type: "image", data: "[accessor property]", mimeType: "image/png" },
    { type: "image", data: "YmluYXJ5", mimeType: "[accessor property]" },
    { type: "text", text: "[unrenderable]" },
    { type: "text", text: "[callable value]" },
    { type: "text", text: "[accessor property]" },
    { type: "text", text: "[unrenderable]" },
    { type: "text", text: "after" },
  ]);
  const damagedEntry = new Proxy(
    [{ type: "text", text: "before" }, null, { type: "text", text: "after" }],
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "1") throw new Error("damaged entry descriptor");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  assert.deepEqual(
    detachedToolResult({ content: damagedEntry }).content.map((part) => part.text),
    ["before", "[unrenderable]", "after"],
  );
  assert.deepEqual(detachedToolResult(Object.create({ content })).content, []);
  assert.equal(detachedToolResult({ content: callable }).content[0].text, "[callable value]");
  assert.equal(detachedToolResult(accessor({}, "details")).details, "[accessor property]");
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.deepEqual(detachedToolResult({ content: revoked.proxy }).content, [
    { type: "text", text: "[unrenderable]" },
  ]);
});

test("details preserve literal keys while marking non-JSON repeated aliases", () => {
  const literal = "diff\n+你🚀\u001b[31m\u202e";
  const shared = { [literal]: literal };
  const details = { first: shared, second: shared };
  const copy = detachedToolResult({ content: [], details });
  assert.deepEqual(copy.details.first, shared);
  assert.notEqual(copy.details.first, shared);
  assert.equal(copy.details.second, "[repeated reference]");
  copy.details.first[literal] = "renderer mutation";
  assert.equal(shared[literal], literal);
});
