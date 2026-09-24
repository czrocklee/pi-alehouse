import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenCount } from "../../../lib/token-format.mjs";
import { formatTokens, formatContextTokens } from "../../dist/ui/format.js";

const cases = [
  [0, "0", "0", "0"],
  [999, "999", "999", "999"],
  [1000, "1.0k", "1.0k", "1k"],
  [9999, "10.0k", "10.0k", "10k"],
  [10000, "10k", "10.0k", "10k"],
  [61200, "61k", "61.2k", "61k"],
  [999499, "999k", "999.5k", "999k"],
  [999500, "1.0M", "999.5k", "1.0M"],
  [999949, "1.0M", "999.9k", "1.0M"],
  [999950, "1.0M", "1.0M", "1.0M"],
  [999999, "1.0M", "1.0M", "1.0M"],
  [1000000, "1.0M", "1.0M", "1.0M"],
  [10000000, "10M", "10.0M", "10M"],
];

test("token surfaces share carry logic while keeping explicit display precision", () => {
  for (const [value, compact, detailed, context] of cases) {
    assert.equal(formatTokenCount(value, { precision: "compact" }), compact, String(value));
    assert.equal(formatTokenCount(value, { precision: "detailed" }), detailed, String(value));
    assert.equal(formatTokens(value, ""), detailed, `billed ${value}`);
    assert.equal(formatTokens(value), `${detailed} token`, `unit ${value}`);
    assert.equal(formatContextTokens(value), context, `context ${value}`);
  }
});

test("neither precision prints 1000k anywhere around its carry boundary", () => {
  for (let value = 999400; value <= 1000100; value++) {
    for (const precision of ["compact", "detailed"]) {
      assert.doesNotMatch(formatTokenCount(value, { precision }), /^1000(?:\.0)?k$/, `${value}/${precision}`);
    }
  }
});

test("unreported and invalid counts remain unknown, not invented zeros", () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, -1]) {
    for (const precision of ["compact", "detailed"]) assert.equal(formatTokenCount(value, { precision }), "?");
  }
});
