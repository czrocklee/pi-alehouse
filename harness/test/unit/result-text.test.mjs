import assert from "node:assert/strict";
import test from "node:test";
import { boundedOutput, validOutput } from "../../dist/core/result-text.js";

test("nonpositive output budgets retain no text rather than slice from the end", () => {
  for (const text of ["", "abc", "甲😀乙"]) for (const cap of [-100, -1, 0]) {
    const output = boundedOutput(text, cap);
    assert.deepEqual(output, { text: "", total_chars: text.length, truncated: text.length > 0 });
    assert(validOutput(output));
  }
});

test("bounded output preserves its existing UTF-16 prefix and truncation contract", () => {
  const text = "甲😀乙";
  for (const [cap, prefix] of [[1, "甲"], [2, "甲"], [3, "甲😀"], [4, text], [100, text]]) {
    const output = boundedOutput(text, cap);
    assert.deepEqual(output, { text: prefix, total_chars: text.length, truncated: prefix !== text });
    assert(validOutput(output));
  }
});
