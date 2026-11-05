import assert from "node:assert/strict";
import test from "node:test";
import { dispatchText } from "../../dist/core/dispatch.js";

test("dispatch names the inherited cwd as its single relative-path base", () => {
  const cwd = '/parent/project "quoted"/line\nbreak';
  const dispatch = Object.freeze({
    inputs: Object.freeze(["src/input.ts", "../sibling.ts", "/explicit/file"]),
    ownership: Object.freeze(["src/output.ts"]), tree: "build", checks: Object.freeze(["focused check"]),
  });
  const original = process.cwd(), text = dispatchText(dispatch, cwd);
  assert(text.includes(`Execution cwd: ${JSON.stringify(cwd)}\n`));
  assert(!text.includes(cwd), "cwd is JSON encoded, not interpolated raw");
  assert.match(text, /Relative inputs, ownership, and tree paths resolve from this cwd/);
  assert.match(text, /not permissions or execution evidence/);
  assert.match(text, /declarations grant no permissions/);
  assert.doesNotMatch(text, /source cwd|binding|worktree|Exclusive/);
  assert(text.includes(`\n${JSON.stringify(dispatch)}\n--- End of dispatch declarations ---`));
  assert.equal(process.cwd(), original, "rendering changes no execution cwd");
  assert.equal(dispatchText(undefined, cwd), "");
});
