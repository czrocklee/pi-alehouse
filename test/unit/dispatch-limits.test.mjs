import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { DISPATCH_LIMITS, validateDispatch } = await createJiti(import.meta.url, {
  fsCache: false,
}).import("../../src/orchestration/core/dispatch.ts");

const items = (count) => Array.from({ length: count }, (_, i) => `input-${i}`);
const failure = (key, resolution, index) => (error) => {
  assert.equal(error.code, "INVALID_DISPATCH");
  assert.equal(error.details.key, key);
  assert.equal(error.details.index, index);
  assert.match(error.details.resolution, resolution);
  assert.doesNotMatch(JSON.stringify(error.details), /private-value/);
  return true;
};

test("core dispatch bounds admit 32 inputs without widening resource/check bounds", () => {
  assert.deepEqual(DISPATCH_LIMITS, { inputs: 32, ownership: 16, checks: 16, stringUnits: 512 });
  assert(Object.isFrozen(DISPATCH_LIMITS));
  validateDispatch({});
  validateDispatch({ inputs: items(9) });
  validateDispatch({ inputs: items(32), ownership: items(16), checks: items(16) });
  for (const [key, limit] of [
    ["inputs", 32],
    ["ownership", 16],
    ["checks", 16],
  ]) {
    assert.throws(
      () => validateDispatch({ [key]: items(limit + 1) }),
      failure(key, new RegExp(`at most ${limit}.*received ${limit + 1}`)),
    );
    assert.throws(() => validateDispatch({ [key]: [] }), failure(key, /at least 1/));
    assert.throws(() => validateDispatch({ [key]: "private-value" }), failure(key, /array/));
    assert.throws(
      () => validateDispatch({ [key]: ["private-value", "private-value"] }),
      failure(key, /unique.*duplicates/),
    );
  }
});

test("core dispatch retains exact UTF-16, padding and literal-path checks with bounded guidance", () => {
  for (const key of ["inputs", "ownership", "checks", "tree"]) {
    const declaration = (text) => ({ [key]: key === "tree" ? text : [text] });
    const index = key === "tree" ? undefined : 0;
    validateDispatch(declaration("🚀".repeat(256)));
    assert.throws(
      () => validateDispatch(declaration("🚀".repeat(257))),
      failure(key, /512 characters.*514/, index),
    );
    assert.throws(
      () => validateDispatch(declaration("private-value" + "x".repeat(512))),
      failure(key, /512 characters/, index),
    );
    assert.throws(() => validateDispatch(declaration("\t")), failure(key, /nonblank/, index));
    assert.throws(
      () => validateDispatch(declaration("private-value\n")),
      failure(key, /control/, index),
    );
    if (key !== "checks") {
      for (const text of [" private-value", "private-value ", "*.ts", "$HOME/file", "~file"])
        assert.throws(
          () => validateDispatch(declaration(text)),
          failure(key, /literal path/, index),
        );
    }
  }
  validateDispatch({ checks: ["test/**/*.mjs", " padded check identifier "] });
});

test("core item indexes remain numeric while field-level errors omit them", () => {
  assert.throws(
    () => validateDispatch({ inputs: ["valid", "private-value "] }),
    failure("inputs", /dispatch\.inputs\.1.*literal path/, 1),
  );
  assert.throws(
    () => validateDispatch({ checks: ["valid", "ok", "🚀".repeat(257)] }),
    failure("checks", /dispatch\.checks\.2.*512 characters/, 2),
  );
});

test("malformed core dispatch diagnostics never echo unknown field names or values", () => {
  for (const raw of [null, [], false, "private-value", { ["private-value".repeat(1000)]: "x" }])
    assert.throws(
      () => validateDispatch(raw),
      (error) => {
        assert.equal(error.code, "INVALID_DISPATCH");
        assert(error.details.resolution.length <= 512);
        assert.doesNotMatch(JSON.stringify(error.details), /private-value/);
        return true;
      },
    );
});
