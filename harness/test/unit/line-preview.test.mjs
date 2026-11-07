import assert from "node:assert/strict";
import test from "node:test";
import { boundedPreview, LinePreview } from "../../dist/runtime/line-preview.js";

// Only the public content block is relevant to this projection seam.
const partial = (content) => ({ content });
const text = (type, contentIndex, value, extra = {}) => ({
  type,
  contentIndex,
  partial: partial(Array.from({ length: contentIndex + 1 }, () => ({ type: "text", text: value }))),
  ...extra,
});
const thought = (type, value, extra = {}) => ({
  type,
  contentIndex: 0,
  partial: partial([{ type: "thinking", thinking: value }]),
  ...extra,
});

test("logical-line prefixes keep the left edge and the last nonblank line across empty tails", () => {
  const preview = new LinePreview();
  preview.append("  first\r\n  second");
  assert.equal(preview.value(), "second");
  preview.append("\r");
  preview.append("\n\n  ");
  assert.equal(preview.value(), "second");
  preview.append("third");
  assert.equal(preview.value(), "third");
  preview.replace(" first\n second\n\n  ");
  assert.equal(preview.value(), "second");
});

test("an overlong current line caps once, resumes on a new line, and never accumulates ellipses", () => {
  const preview = new LinePreview();
  preview.append("x".repeat(1024));
  assert.equal(preview.value(), "x".repeat(1024));
  for (let index = 0; index < 100; index++) preview.append("more");
  assert.equal(preview.value(), `${"x".repeat(1024)}…`);
  preview.append("\nnext");
  assert.equal(preview.value(), "next");
  preview.clear();
  assert.equal(preview.value(), "");
});

test("storage bounds preserve full emoji, combining and joined grapheme clusters", () => {
  for (const cluster of ["👩‍💻", "a\u0301", "✈️", "🇨🇳"]) {
    assert.equal(boundedPreview(`abc${cluster}tail`, 3), "abc…");
    assert.equal(boundedPreview(`abc${cluster}tail`, 3 + cluster.length), `abc${cluster}…`);
  }
  assert.equal(boundedPreview("abc", 3), "abc");
});

test("a surrogate pair split across deltas is withheld until complete, including near the cap", () => {
  const preview = new LinePreview();
  preview.append("start \ud83d");
  assert.equal(preview.value(), "start ");
  preview.append("\ude00");
  assert.equal(preview.value(), "start 😀");
  preview.clear();
  preview.append(`${"x".repeat(1023)}\ud83d`);
  assert.equal(preview.value(), "x".repeat(1023));
  preview.append("\ude00");
  assert.equal(preview.value(), `${"x".repeat(1023)}…`);
});

test("new block indexes and explicit starts reset the channel, without reviving earlier prose", () => {
  const preview = new LinePreview();
  preview.update(text("text_delta", 0, "old", { delta: "old" }));
  assert.equal(preview.value(), "old");
  preview.update(text("text_delta", 2, "new", { delta: "new" }));
  assert.equal(preview.value(), "new");
  preview.update(text("text_start", 2, ""));
  assert.equal(preview.value(), "");
  preview.update(text("text_delta", 2, "after", { delta: "after" }));
  assert.equal(preview.value(), "after");
});

test("end content is authoritative even when it corrects a previously capped streamed block", () => {
  const preview = new LinePreview();
  preview.update(thought("thinking_delta", "x".repeat(2000), { delta: "x".repeat(2000) }));
  assert.equal(preview.value(), `${"x".repeat(1024)}…`);
  preview.update(thought("thinking_end", "stale partial", { content: "corrected\nfinal line" }));
  assert.equal(preview.value(), "final line");
  preview.update(thought("thinking_end", "stale partial", { content: "" }));
  assert.equal(preview.value(), "");
});

test("redacted thinking is absent at start, delta and authoritative end", () => {
  const preview = new LinePreview();
  preview.update(thought("thinking_delta", "public", { delta: "public" }));
  for (const type of ["thinking_start", "thinking_delta", "thinking_end"]) {
    preview.update({
      type,
      contentIndex: 0,
      delta: "opaque",
      content: "opaque",
      partial: partial([
        {
          type: "thinking",
          redacted: true,
          get thinking() {
            throw new Error("redacted content must not be read");
          },
          get thinkingSignature() {
            throw new Error("opaque signatures must not be read");
          },
        },
      ]),
    });
    assert.equal(preview.value(), "");
  }
  preview.update(thought("thinking_delta", "public again", { delta: "public again" }));
  assert.equal(preview.value(), "public again");
});

for (const [name, open, close] of [
  ["OSC BEL", "\x1b]0;", "\x07"],
  ["OSC ST", "\x1b]0;", "\x1b\\"],
  ["APC ST", "\x1b_", "\x1b\\"],
  ["C1 OSC ST", "\x9d0;", "\x9c"],
  ["C1 APC ST", "\x9f", "\x9c"],
]) {
  test(`${name} multiline payload is suppressed before and after its terminator`, () => {
    const preview = new LinePreview();
    preview.replace(`visible\n${open}hidden\nsecret-payload`);
    assert.equal(preview.value(), "visible");
    preview.replace(`visible\n${open}hidden\nsecret-payload${close}\npublic`);
    assert.equal(preview.value(), "public");
  });

  test(`${name} split across chunks uses cumulative public content, not payload lines`, () => {
    const preview = new LinePreview();
    let cumulative = "";
    for (const delta of [
      "visible\n",
      open[0],
      open.slice(1),
      "hidden\n",
      "secret-payload",
      close,
      "\npublic",
    ]) {
      cumulative += delta;
      preview.append(delta, cumulative);
      assert.doesNotMatch(preview.value(), /hidden|secret-payload/);
    }
    assert.equal(preview.value(), "public");
  });
}

test("an ESC without cumulative content fails closed until a safe cumulative block is available", () => {
  const preview = new LinePreview();
  preview.append("earlier");
  preview.append("\x1b]0;hidden\nsecret");
  assert.equal(preview.value(), "");
  preview.append("more payload");
  assert.equal(preview.value(), "");
  preview.append("\npublic", "earlier\x1b]0;hidden\nsecret\x07\npublic");
  assert.equal(preview.value(), "public");
  preview.clear();
  preview.append("fresh");
  assert.equal(preview.value(), "fresh");
});

test("normal prose uses deltas rather than reprocessing the growing public block", () => {
  const preview = new LinePreview();
  preview.update(
    text("text_delta", 0, "unrelated cumulative content".repeat(10000), { delta: "first" }),
  );
  preview.update(
    text("text_delta", 0, "unrelated cumulative content".repeat(10000), { delta: " second" }),
  );
  assert.equal(preview.value(), "first second");
});

test("an unfinished protocol supplied through replacement still requires cumulative recovery", () => {
  const preview = new LinePreview();
  preview.replace("visible\n\x1b_hidden\nsecret-payload");
  assert.equal(preview.value(), "visible");
  preview.append("still hidden");
  assert.equal(preview.value(), "");
  preview.append("public", "visible\n\x1b_hidden\nsecret-payload\x1b\\\npublic");
  assert.equal(preview.value(), "public");
});

test("protocol recovery and normal deltas sanitize controls without altering normal Unicode", () => {
  const preview = new LinePreview();
  preview.append("\x1b[31m中", "\x1b[31m中");
  preview.append("文 👩‍💻\x1b[0m", "\x1b[31m中文 👩‍💻\x1b[0m");
  assert.equal(preview.value(), "中文 👩‍💻");
  preview.clear();
  preview.append("x\x00\u202ey");
  assert.equal(preview.value(), "x\\x00\\u202ey");
});
