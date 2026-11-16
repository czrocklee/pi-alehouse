import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { Check } from "typebox/value";

// Source-level witness check: no build output, SDK, credentials or network.
const jiti = createJiti(import.meta.url, { fsCache: false });
const { parentSchemaFailure } = await jiti.import(
  "../../src/orchestration/tools/schema-diagnostics.ts",
);
const { spawnSchema, answerSchema, waitSchema, readSchema, listSchema, checkParentToolArguments } =
  await jiti.import("../../src/orchestration/tools/parent-schemas.ts");
const { OrchestrationError } = await jiti.import("../../src/orchestration/core/ports.ts");

const base = {
  agent: "a",
  prompt: "p",
  label: "l",
  profile: "worker",
  reasoning_difficulty: 1,
};
const hasControl = (text) =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function failure(schema, raw) {
  const error = parentSchemaFailure(schema, raw);
  assert(error instanceof OrchestrationError);
  assert.equal(error.name, "OrchestrationError");
  assert.equal(error.code, "INVALID_PARAMETERS");
  assert.equal(typeof error.details.resolution, "string");
  assert(error.details.resolution.length > 0);
  assert(!hasControl(error.details.resolution));
  if (error.details.key !== undefined) {
    assert.equal(typeof error.details.key, "string");
    assert(error.details.key.length > 0 && error.details.key.length <= 128);
    assert(!hasControl(error.details.key));
  }
  if (error.details.allowed !== undefined) {
    assert(Array.isArray(error.details.allowed));
    assert(error.details.allowed.length <= 32);
    for (const value of error.details.allowed) {
      assert.equal(typeof value, "string");
      assert(value.length <= 128);
      assert(!hasControl(value));
    }
  }
  assert(Buffer.byteLength(JSON.stringify(error.details)) < 8192);
  return error;
}

function noEcho(error, text) {
  assert(!JSON.stringify(error.details).includes(text));
}

test("root type failure is generic, bounded and allowed-only", () => {
  const error = failure(spawnSchema, "not an object");
  assert.equal(error.details.key, undefined);
  assert.match(error.details.resolution, /do not match this tool's schema/);
  assert(error.details.allowed.includes("agent"));
  assert(error.details.allowed.includes("dispatch"));
  noEcho(error, "not an object");
});

test("root required errors select the first known missing field", () => {
  const empty = failure(spawnSchema, {});
  assert.equal(empty.details.key, "agent");
  assert.equal(empty.details.resolution, "agent is required.");
  assert(empty.details.allowed.includes("prompt"));
  const partial = failure(spawnSchema, { agent: "a" });
  assert.equal(partial.details.key, "prompt");
  assert.equal(partial.details.resolution, "prompt is required.");
});

test("first actionable error keeps TypeBox order before a later extra field", () => {
  const error = failure(spawnSchema, { agent: "a", evil: 1 });
  assert.equal(error.details.key, "prompt");
  assert.equal(error.details.resolution, "prompt is required.");
  noEcho(error, "evil");
});

test("nested required errors point at the parent object and name a known field", () => {
  const empty = failure(spawnSchema, { ...base, return_to: {} });
  assert.equal(empty.details.key, "return_to.agent");
  assert.equal(empty.details.resolution, "return_to.agent is required.");
  assert.deepEqual(empty.details.allowed, ["agent", "question_id", "instruction"]);
  const partial = failure(spawnSchema, { ...base, return_to: { agent: "b" } });
  assert.equal(partial.details.key, "return_to.question_id");
});

test("type errors map known fields and bounded array indexes", () => {
  const boolean = failure(spawnSchema, { ...base, inherit_context: "SECRET_BOOLEAN" });
  assert.equal(boolean.details.key, "inherit_context");
  assert.match(boolean.details.resolution, /boolean/);
  noEcho(boolean, "SECRET_BOOLEAN");
  const array = failure(spawnSchema, { ...base, dispatch: { required_paths: "SECRET_ARRAY" } });
  assert.equal(array.details.key, "dispatch.required_paths");
  assert.match(array.details.resolution, /array/);
  noEcho(array, "SECRET_ARRAY");
  const item = failure(spawnSchema, { ...base, dispatch: { required_paths: [1] } });
  assert.equal(item.details.key, "dispatch.required_paths.0");
  assert.match(item.details.resolution, /string/);
  const indexed = failure(
    Type.Object({ values: Type.Array(Type.String()) }, { additionalProperties: false }),
    { values: [...Array.from({ length: 32 }, (_, i) => `v${i}`), 1] },
  );
  assert.equal(indexed.details.key, "values.32");
});

test("Agent names with trailing line breaks are rejected with the exact parameter", () => {
  for (const suffix of ["\n", "\r\n", "\u2028"]) {
    assert.throws(
      () => checkParentToolArguments("agent_spawn", spawnSchema, { ...base, agent: `a${suffix}` }),
      (error) => {
        assert.equal(error.code, "INVALID_PARAMETERS");
        assert.equal(error.details.key, "agent");
        assert.match(error.details.resolution, /required format/);
        return true;
      },
    );
  }
});

test("the defensive complete-name check retains every known field/index", () => {
  const question = { agent: "BAD", question_id: `q_${"a".repeat(32)}`, instruction: "Continue" };
  for (const [name, schema, raw, parameter] of [
    ["agent_spawn", spawnSchema, { ...base, agent: "BAD" }, "agent"],
    ["agent_wait", waitSchema, { agents: ["a", "BAD"] }, "agents.1"],
    ["agent_spawn", spawnSchema, { ...base, after: ["a", "BAD"] }, "after.1"],
    [
      "agent_spawn",
      spawnSchema,
      { ...base, profile: "scout", return_to: question },
      "return_to.agent",
    ],
  ]) {
    // Isolate a hypothetical schema/core disagreement without changing the
    // registered schemas or making the real production naming rule permissive.
    const relaxed = structuredClone(schema);
    const target =
      parameter === "agent"
        ? relaxed.properties.agent
        : parameter.startsWith("agents.")
          ? relaxed.properties.agents.items
          : parameter.startsWith("after.")
            ? relaxed.properties.after.items
            : relaxed.properties.return_to.properties.agent;
    delete target.pattern;
    assert.equal(Check(relaxed, raw), true);
    assert.throws(
      () => checkParentToolArguments(name, relaxed, raw),
      (error) => {
        assert.equal(error.code, "INVALID_PARAMETERS");
        assert.equal(error.details.key, parameter);
        assert.match(error.details.resolution, /complete Agent name/);
        noEcho(error, "BAD");
        return true;
      },
    );
  }
});

test("enum failures expose bounded schema values, never the raw choice", () => {
  const profile = failure(spawnSchema, { ...base, profile: "SECRET_PROFILE" });
  assert.equal(profile.details.key, "profile");
  assert.deepEqual(profile.details.allowed, ["worker", "scout"]);
  assert.match(profile.details.resolution, /allowed values/);
  noEcho(profile, "SECRET_PROFILE");
  const mode = failure(waitSchema, { mode: "SECRET_MODE" });
  assert.equal(mode.details.key, "mode");
  assert.deepEqual(mode.details.allowed, ["all", "any"]);
  noEcho(mode, "SECRET_MODE");
});

test("bounds use schema limits and safe counts without echoing values", () => {
  const minItems = failure(spawnSchema, { ...base, dispatch: { required_paths: [] } });
  assert.equal(minItems.details.key, "dispatch.required_paths");
  assert.match(minItems.details.resolution, /at least 1 item/);
  assert.match(minItems.details.resolution, /it has 0/);
  const maxInputs = spawnSchema.properties.dispatch.properties.required_paths.maxItems;
  const maxItems = failure(spawnSchema, {
    ...base,
    dispatch: { required_paths: Array.from({ length: maxInputs + 1 }, (_, i) => `/in${i}`) },
  });
  assert.equal(maxItems.details.key, "dispatch.required_paths");
  assert.match(maxItems.details.resolution, new RegExp(`at most ${maxInputs} items`));
  assert.match(maxItems.details.resolution, new RegExp(`it has ${maxInputs + 1}`));
  const tooLong = failure(spawnSchema, { ...base, label: "S".repeat(73) });
  assert.equal(tooLong.details.key, "label");
  assert.match(tooLong.details.resolution, /at most 72 characters/);
  assert.match(tooLong.details.resolution, /it has 73/);
  noEcho(tooLong, "S".repeat(73));
  const shortId = failure(spawnSchema, {
    ...base,
    return_to: { agent: "b", question_id: "q", instruction: "a" },
  });
  assert.equal(shortId.details.key, "return_to.question_id");
  assert.match(
    shortId.details.resolution,
    /exact pending question_id token copied from agent_wait or agent_read/,
  );
  assert.doesNotMatch(shortId.details.resolution, /UTF-16|it has|\d+ characters/);
  const minimum = failure(readSchema, { agent: "a", task: 0 });
  assert.equal(minimum.details.key, "task");
  assert.match(minimum.details.resolution, /at least 1/);
  const maximum = failure(readSchema, { agent: "a", max_chars: 99999 });
  assert.equal(maximum.details.key, "max_chars");
  assert.match(maximum.details.resolution, /at most 16384/);
});

test("uniqueItems and pattern failures stay generic", () => {
  const duplicate = failure(spawnSchema, { ...base, dispatch: { required_paths: ["/a", "/a"] } });
  assert.equal(duplicate.details.key, "dispatch.required_paths");
  assert.match(duplicate.details.resolution, /duplicate entries/);
  const pattern = failure(spawnSchema, { ...base, agent: "a*" });
  assert.equal(pattern.details.key, "agent");
  assert.match(pattern.details.resolution, /required format/);
  noEcho(pattern, "a*");
  noEcho(pattern, "\\x00");
});

test("33 items fail a synthetic maxItems 32 schema while 32 pass", () => {
  const synthetic = Type.Object(
    { checks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 }) },
    { additionalProperties: false },
  );
  const atLimit = { checks: Array.from({ length: 32 }, (_, i) => `c${i}`) };
  const overLimit = { checks: Array.from({ length: 33 }, (_, i) => `c${i}`) };
  assert.equal(Check(synthetic, atLimit), true);
  assert.equal(Check(synthetic, overLimit), false);
  const error = failure(synthetic, overLimit);
  assert.equal(error.details.key, "checks");
  assert.match(error.details.resolution, /at most 32 items/);
  assert.match(error.details.resolution, /it has 33/);
});

test("array cardinality is diagnosed before invalid or unmappable individual items", () => {
  for (const [length, badIndex] of [
    [33, 0],
    [200, 150],
  ]) {
    const inputs = Array.from({ length }, (_, index) =>
      index === badIndex ? 42 : `input-${index}`,
    );
    assert.equal(Check(spawnSchema, { ...base, dispatch: { required_paths: inputs } }), false);
    const error = failure(spawnSchema, { ...base, dispatch: { required_paths: inputs } });
    assert.equal(error.details.key, "dispatch.required_paths");
    assert.match(error.details.resolution, new RegExp(`at most 32 items; it has ${length}`));
    noEcho(error, "input-");
  }
});

test("oversized duplicate-heavy arrays avoid TypeBox item and uniqueness diagnostics", () => {
  let itemReads = 0;
  const inputs = new Proxy(Array(5000).fill("duplicate-private-value"), {
    get(target, key) {
      if (key === "length") return target.length;
      itemReads++;
      throw new Error("diagnostics must not traverse this oversized array");
    },
  });
  const raw = { ...base, dispatch: { required_paths: inputs } };
  // The shortcut reads data descriptors only; it must not evaluate a sibling
  // accessor in order to locate the bounded input array.
  let getterReads = 0;
  Object.defineProperty(raw, "return_to", {
    get() {
      getterReads++;
      throw new Error("do not invoke getters to diagnose cardinality");
    },
  });
  const error = failure(spawnSchema, raw);
  assert.equal(error.details.key, "dispatch.required_paths");
  assert.match(error.details.resolution, /at most 32 items; it has 5000/);
  assert.equal(itemReads, 0);
  assert.equal(getterReads, 0);
  noEcho(error, "duplicate-private-value");
});

test("the early cardinality diagnostic derives both bounds from the schema", () => {
  const schema = Type.Object({ values: Type.Array(Type.String(), { minItems: 3, maxItems: 7 }) });
  for (const [values, message] of [
    [[], /at least 3 items; it has 0/],
    [Array(8).fill("same"), /at most 7 items; it has 8/],
  ]) {
    const error = failure(schema, { values });
    assert.equal(error.details.key, "values");
    assert.match(error.details.resolution, message);
  }
});

test("later actionable errors survive an unmappable earlier item path", () => {
  const schema = Type.Object({
    values: Type.Array(Type.String()),
    limit: Type.Integer({ maximum: 3 }),
  });
  const values = Array.from({ length: 200 }, (_, index) => (index === 150 ? 42 : "value"));
  const error = failure(schema, { values, limit: 4 });
  assert.equal(error.details.key, "limit");
  assert.match(error.details.resolution, /at most 3/);
});

test("minLength never labels TypeBox's grapheme-style count as UTF-16 units", () => {
  const token = "q_" + "a\u0301".repeat(16);
  assert.equal(token.length, 34);
  for (const [schema, raw, key] of [
    [answerSchema, { agent: "a", question_id: token, answer: "Continue" }, "question_id"],
    [
      spawnSchema,
      { ...base, return_to: { agent: "b", question_id: token, instruction: "Continue" } },
      "return_to.question_id",
    ],
  ]) {
    assert.equal(Check(schema, raw), false);
    const error = failure(schema, raw);
    assert.equal(error.details.key, key);
    assert.match(
      error.details.resolution,
      /exact pending question_id token copied from agent_wait or agent_read/,
    );
    assert.doesNotMatch(error.details.resolution, /UTF-16|it has|\d+ characters/);
    noEcho(error, token);
  }
  const generic = failure(Type.Object({ value: Type.String({ minLength: 3 }) }), {
    value: "a\u0301",
  });
  assert.equal(generic.details.key, "value");
  assert.match(generic.details.resolution, /minimum string-length requirement of 3/);
  assert.doesNotMatch(generic.details.resolution, /UTF-16|it has|\d+ characters/);
});

test("question_id maxLength and pattern errors use the same copy-token guidance", () => {
  for (const token of ["q_" + "a".repeat(33), "q_" + "z".repeat(32)]) {
    const error = failure(answerSchema, { agent: "a", question_id: token, answer: "Continue" });
    assert.equal(error.details.key, "question_id");
    assert.match(error.details.resolution, /exact pending question_id token copied/);
    assert.match(error.details.resolution, /q_ followed by 32 lowercase hex digits/);
    assert.doesNotMatch(error.details.resolution, /UTF-16|it has|\d+ characters/);
    noEcho(error, token);
  }
});

test("hostile extra keys are reported by object, never echoed", () => {
  const hostile = "evil/\u0000\n-extra";
  const root = failure(spawnSchema, { ...base, [hostile]: "SECRET_EXTRA_VALUE" });
  assert.equal(root.details.key, undefined);
  assert.match(root.details.resolution, /undeclared field/);
  assert(root.details.allowed.includes("agent"));
  noEcho(root, "evil");
  noEcho(root, "SECRET_EXTRA_VALUE");
  const dispatch = failure(spawnSchema, { ...base, dispatch: { [hostile]: 1 } });
  assert.equal(dispatch.details.key, "dispatch");
  assert.deepEqual(dispatch.details.allowed, [
    "required_paths",
    "ownership",
    "build_dir",
    "checks",
  ]);
  assert.match(dispatch.details.resolution, /dispatch contains an undeclared field/);
  noEcho(dispatch, "evil");
  const questionId = `q_${"a".repeat(32)}`;
  const returnTo = failure(spawnSchema, {
    ...base,
    return_to: { agent: "b", question_id: questionId, instruction: "a", [hostile]: 1 },
  });
  assert.equal(returnTo.details.key, "return_to");
  assert.deepEqual(returnTo.details.allowed, ["agent", "question_id", "instruction"]);
  assert.match(returnTo.details.resolution, /return_to contains an undeclared field/);
  noEcho(returnTo, "evil");
  const list = failure(listSchema, { [hostile]: 1 });
  assert.equal(list.details.key, undefined);
  assert.equal(list.details.allowed, undefined);
  assert.match(list.details.resolution, /undeclared field/);
  noEcho(list, "evil");
});

test("prototype-like extra keys are not echoed or installed", () => {
  const raw = { ...base };
  Object.defineProperty(raw, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const error = failure(spawnSchema, raw);
  assert.equal(error.details.key, undefined);
  assert.match(error.details.resolution, /undeclared field/);
  noEcho(error, "polluted");
  assert.equal({}.polluted, undefined);
});

test("unsupported composite schemas fall back to generic top-level guidance", () => {
  const anyOf = Type.Object(
    { value: Type.Unsafe({ anyOf: [{ type: "string" }, { type: "number" }] }) },
    { additionalProperties: false },
  );
  const error = failure(anyOf, { value: true });
  assert.equal(error.details.key, undefined);
  assert.deepEqual(error.details.allowed, ["value"]);
  assert.match(error.details.resolution, /do not match this tool's schema/);
});

test("unknown or hostile schema property names never become keys", () => {
  const longName = "x".repeat(200);
  const longSchema = Type.Object({ [longName]: Type.String() }, { additionalProperties: false });
  const longError = failure(longSchema, { [longName]: 1 });
  assert.equal(longError.details.key, undefined);
  assert.equal(longError.details.allowed, undefined);
  noEcho(longError, longName);
  const controlName = "bad\u0000/name";
  const controlSchema = Type.Object(
    { [controlName]: Type.String() },
    { additionalProperties: false },
  );
  const controlError = failure(controlSchema, { [controlName]: 1 });
  assert.equal(controlError.details.key, undefined);
  assert.equal(controlError.details.allowed, undefined);
  noEcho(controlError, "bad");
});

test("bounded enum values do not grow the allowed list", () => {
  const values = Array.from({ length: 40 }, (_, i) => `v${i}`);
  const enumSchema = Type.Object(
    { choice: Type.Unsafe({ type: "string", enum: values }) },
    { additionalProperties: false },
  );
  const error = failure(enumSchema, { choice: "SECRET_CHOICE" });
  assert.equal(error.details.key, "choice");
  assert.equal(error.details.allowed.length, 32);
  assert.deepEqual(error.details.allowed, values.slice(0, 32));
  noEcho(error, "SECRET_CHOICE");
});
