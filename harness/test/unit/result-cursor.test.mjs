import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeResultCursor, encodeResultCursor, resultCursorKey, RESULT_CURSOR_LENGTH } from "../../dist/core/result-cursor.js";

const identity = Object.freeze({ owner: "owner", generation: "generation", run: "run", version: "version" });
const invalid = (error) => error.code === "INVALID_CURSOR";

test("compact result identity has an independent domain, exact JSON preimage and first 128 digest bits", () => {
  const digest = createHash("sha256").update(JSON.stringify([
    "pi-alehouse/result-cursor/v1", "owner", "generation", "run", "version",
  ])).digest().subarray(0, 16).toString("base64url");
  assert.equal(digest, "vJg_LkhWtYWFncK4L6qSVA");
  assert.equal(resultCursorKey(identity), digest);
  assert.equal(encodeResultCursor(identity, 0), "r1_vJg_LkhWtYWFncK4L6qSVA.00000000000");
  for (const field of ["owner", "generation", "run", "version"]) {
    assert.notEqual(resultCursorKey({ ...identity, [field]: identity[field] + "-other" }), digest, field);
  }
});

for (const offset of [0, 1, 35, 36, 1295, 1296, 16384, 1048576, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])
  test(`fixed-width cursor round-trips ${offset} without growing future reservations`, () => {
    const encoded = encodeResultCursor(identity, offset);
    assert.equal(RESULT_CURSOR_LENGTH, 37); assert.equal(encoded.length, 37);
    assert.match(encoded, /^r1_[A-Za-z0-9_-]{22}\.[0-9a-z]{11}$/);
    assert.deepEqual(decodeResultCursor(encoded), { key: resultCursorKey(identity), offset });
    // No escaping inside either JSON layer: fingerprint/offset are bounded ASCII.
    assert.equal(JSON.stringify(encoded).length, 39);
  });

for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined])
  test(`encoder rejects non-safe offset ${String(offset)}`, () => assert.throws(() => encodeResultCursor(identity, offset), invalid));

const cursor = encodeResultCursor(identity, 0);
for (const malformed of [undefined, null, 0, {}, "", cursor + "\n", cursor + " ", " " + cursor,
  cursor.replace("r1_", "r2_"), cursor.slice(0, -1), cursor.replace(".00000000000", ".0"),
  cursor.replace(".00000000000", ".000000000-1"), cursor.replace(".00000000000", ".00000000NaN"),
  cursor.replace(".00000000000", ".zzzzzzzzzzz"), cursor.replace(".00000000000", ".2gosa7pa2gw"),
  cursor.replace(".00000000000", ".0000000000A"), cursor.replace("SVA.", "SVB."), cursor.replace("SVA.", "SV=."),
  "r1_" + "A".repeat(1000) + ".00000000000"])
  test(`decoder rejects malformed/noncanonical cursor ${JSON.stringify(malformed)?.slice(0, 100)}`, () => {
    assert.throws(() => decodeResultCursor(malformed), invalid);
  });
