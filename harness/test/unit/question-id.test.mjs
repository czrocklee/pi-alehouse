import assert from "node:assert/strict";
import test from "node:test";
import { isQuestionId, questionId, QUESTION_ID_PATTERN } from "../../dist/core/question-id.js";

// Independently computed with Python hashlib.sha256 and compact json.dumps.
// UTF-8 preimage: ["pi-alehouse/question/v1","owner-1","generation-1","run-1"]
// Full digest: 0dd7797d66c42bf3ef2b77a85ee5899c0cbdbf9f562e986604ce0ad2e4a5e194
const KNOWN_ID = "q_0dd7797d66c42bf3ef2b77a85ee5899c";

test("question token is the first 16 SHA256 bytes of the exact namespaced JSON array", () => {
  const id = questionId("owner-1", "generation-1", "run-1");
  assert.equal(id, KNOWN_ID);
  assert.equal(id.length, 34);
  assert.equal(QUESTION_ID_PATTERN, "^q_[0-9a-f]{32}$");
  assert.match(id, new RegExp(QUESTION_ID_PATTERN));
  assert(isQuestionId(id));
});

test("question tokens are deterministic derived data, not presentation or reservation state", () => {
  assert.equal(questionId("owner-1", "generation-1", "run-1"), KNOWN_ID);
  questionId("other-owner", "other-generation", "other-run");
  assert.equal(questionId("owner-1", "generation-1", "run-1"), KNOWN_ID);
});

for (const [component, identity] of [
  ["owner", ["owner-2", "generation-1", "run-1"]],
  ["generation", ["owner-1", "generation-2", "run-1"]],
  ["original Run", ["owner-1", "generation-1", "run-2"]],
]) {
  test(`question token changes with ${component}, even when Agent/task names can be reused`, () => {
    const id = questionId(...identity);
    assert.notEqual(id, KNOWN_ID);
    assert.equal(id.length, 34);
    assert(isQuestionId(id));
  });
}

test("JSON tuple encoding preserves boundaries instead of concatenating identities", () => {
  assert.notEqual(questionId("ab", "c", "d"), questionId("a", "bc", "d"));
  assert.notEqual(questionId("a:b", "c", "d"), questionId("a", "b:c", "d"));
  assert.notEqual(questionId("a", "b", "c\u0000"), questionId("a", "b\u0000", "c"));
});

test("JSON escaping and UTF-8 encoding cover controls, Unicode, and lone surrogates", () => {
  // Independently computed with Python hashlib; literal UTF-8 Unicode, escaped
  // NUL/quote/backslash and well-formed JSON's escaped lone high surrogate.
  // Full digest: 4b4559a8199c7579849b6694566144e2eb4449527eaa03c6ba5ae8c856c50865
  assert.equal(questionId("主人😀", "generation\u0000\"\\", "run\ud800"),
    "q_4b4559a8199c7579849b6694566144e2");
  assert.notEqual(questionId("owner", "generation", "run\ud800"), questionId("owner", "generation", "run\udfff"));
});

test("question token predicate accepts only the exact lowercase 34-character syntax", () => {
  for (const invalid of [
    undefined, null, 42, {}, [], "", "q_", "q_" + "a".repeat(31), "q_" + "a".repeat(33),
    "q_" + "A".repeat(32), "q_" + "g".repeat(32), "Q_" + "a".repeat(32),
    " " + KNOWN_ID, KNOWN_ID + " ", KNOWN_ID + "\n", KNOWN_ID + "\r\n", "q_" + "a".repeat(64),
  ]) assert.equal(isQuestionId(invalid), false, String(invalid));
  assert(isQuestionId("q_" + "0".repeat(32)));
  assert(isQuestionId("q_" + "f".repeat(32)));
});
