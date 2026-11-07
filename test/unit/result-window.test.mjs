import assert from "node:assert/strict";
import test from "node:test";
import {
  sliceResultWindow,
  splitsSurrogatePair,
} from "../../dist/orchestration/core/result-window.js";
import { encodeResultCursor } from "../../dist/orchestration/core/result-cursor.js";
import { boundedOutput } from "../../dist/orchestration/core/result-text.js";
import { ended, fixture, task, until } from "../support/controller-fixture.mjs";

// Pure UTF-16 seams and controlled core ports only; no SDK/provider evidence.
test("result boundary detection distinguishes pairs from isolated surrogates and EOF", () => {
  for (const [text, expected] of [
    ["", []],
    ["abc", []],
    ["😀", [1]],
    ["a😀🚀z", [2, 4]],
    ["\ud800x\udfff", []],
    ["\ud800\ud800\udfff\udfff", [2]],
  ]) {
    for (let offset = 0; offset <= text.length; offset++)
      assert.equal(splitsSurrogatePair(text, offset), expected.includes(offset));
  }
});

test("shared result windows match the UTF-16 page rule at every valid offset and limit", () => {
  for (const text of ["", "abc", "a😀🚀z", "\ud800x\udfff", "😀\ud800x\udfff🚀"]) {
    for (let offset = 0; offset <= text.length; offset++) {
      if (splitsSurrogatePair(text, offset)) continue;
      for (let limit = 1; limit <= text.length + 1; limit++) {
        let end = Math.min(text.length, offset + limit);
        if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(text[end] ?? ""))
          end++;
        const page = sliceResultWindow(text, offset, limit);
        assert.deepEqual(page, { text: text.slice(offset, end), end });
        assert.equal(splitsSurrogatePair(text, page.end), false);
        assert(page.text.length <= limit + 1);
        if (offset < text.length) assert(page.end > offset);
      }
    }
    for (let limit = 1; limit <= text.length + 1; limit++) {
      const parts = [];
      let offset = 0;
      while (offset < text.length) {
        const page = sliceResultWindow(text, offset, limit);
        parts.push(page.text);
        offset = page.end;
      }
      assert.equal(parts.join(""), text, "paging neither loses nor repeats a UTF-16 unit");
    }
  }
  assert.deepEqual(sliceResultWindow("😀", 0, 1), { text: "😀", end: 2 });
});

const read = async (controller, agent_id, rest = {}) =>
  JSON.parse(
    (await controller.observe({ kind: "read", agent_id, max_chars: 1, ...rest }, { validate() {} }))
      .content[0].text,
  ).agents[0];

test("getResult and model read use the same compact cursor and page boundaries", async (t) => {
  const { controller: c, ports } = await fixture(t);
  c.bindModelCommunication();
  const run = await c.submit("pages", task("pages", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  const text = "a😀b🚀c";
  ports[0].finish(text);
  await ended(c, run);
  let cursor;
  const parts = [];
  for (;;) {
    const page = c.getResult(run.run_id, { limit: 1, cursor });
    const row = await read(c, run.agent_id, cursor ? { cursor } : {});
    assert.equal(row.result, page.text);
    assert.equal(page.retained_chars, text.length);
    assert.equal(page.total_chars, text.length);
    assert.equal(page.complete, page.next_cursor === undefined);
    assert.equal(page.truncated, page.next_cursor !== undefined);
    assert.equal(row.next_cursor, page.next_cursor);
    parts.push(page.text);
    cursor = page.next_cursor;
    if (!cursor) break;
    assert.match(cursor, /^r1_/);
    assert.equal(cursor.length, 37);
  }
  assert.equal(parts.join(""), text);

  const first = c.getResult(run.run_id, { limit: 1 });
  const identity = {
    owner: c.identity.owner_id,
    generation: c.identity.generation,
    run: run.run_id,
    version: first.result_ref.digest,
  };
  const unsupported = Buffer.from(
    JSON.stringify({
      owner: identity.owner,
      run: identity.run,
      version: identity.version,
      offset: 1,
    }),
  ).toString("base64url");
  const before = c.presentationRevision;
  for (const cursor of [
    "",
    unsupported,
    encodeResultCursor(identity, 2),
    encodeResultCursor(identity, text.length + 1),
    encodeResultCursor({ ...identity, generation: "different" }, 0),
  ]) {
    assert.throws(() => c.getResult(run.run_id, { cursor }), { code: "INVALID_CURSOR" });
    await assert.rejects(read(c, run.agent_id, { cursor }), { code: "INVALID_CURSOR" });
  }
  assert.equal(c.presentationRevision, before, "invalid cursors publish no communication");
});

test("live windows have no cursor and retained EOF preserves never-retained omission", async (t) => {
  const { controller: c, ports } = await fixture(t, { controller: { output_chars: 3 } });
  const run = await c.submit("retained", task("retained", { name: "otter" }));
  await until(() => ports[0]?.streaming);
  ports[0].callbacks.output(boundedOutput("😀z!", 16384));
  const preview = c.getResult(run.run_id, { limit: 1 });
  assert.equal(preview.text, "😀");
  assert.equal(preview.complete, false);
  assert.equal(preview.next_cursor, undefined);
  const live = await read(c, run.agent_id);
  assert.equal(live.result, "😀");
  assert.equal(live.next_cursor, undefined);

  ports[0].finish("😀z!");
  await ended(c, run);
  const page = c.getResult(run.run_id, { limit: 3 });
  assert.equal(page.text, "😀z");
  assert.equal(page.retained_chars, 3);
  assert.equal(page.total_chars, 4);
  assert.equal(page.complete, false);
  assert.equal(page.truncated, true);
  assert.equal(page.next_cursor, undefined);
  const row = await read(c, run.agent_id, { max_chars: 3 });
  assert.equal(row.result, page.text);
  assert.equal(row.omitted_chars, 1);
  assert.equal(row.result_omitted, undefined, "retention loss is omitted_chars, not page omission");
  assert.equal(row.next_cursor, undefined);
});
