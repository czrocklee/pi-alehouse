import assert from "node:assert/strict";
import test from "node:test";
import { dispatchText } from "../../dist/core/dispatch.js";

test("dispatch names execution cwd as the single path base and source cwd only for inheritance", () => {
  const sourceCwd = '/source/project "quoted"/line\nbreak';
  const executionCwd = '/retained/worktree "quoted"/nested';
  const dispatch = Object.freeze({
    inputs: Object.freeze(["src/input.ts", "../sibling.ts", "/explicit/source/file"]),
    ownership: Object.freeze(["src/output.ts"]),
    tree: "build",
    checks: Object.freeze(["focused check"]),
  });
  const cwd = process.cwd();
  const text = dispatchText(dispatch, executionCwd, sourceCwd);
  assert.ok(text.includes(`Execution cwd: ${JSON.stringify(executionCwd)}\n`));
  assert.ok(text.includes(`source cwd (${JSON.stringify(sourceCwd)})`));
  assert.ok(!text.includes(sourceCwd), "source cwd is JSON encoded, not interpolated raw");
  assert.match(text, /Relative inputs, ownership, and tree paths resolve from this execution cwd/);
  assert.match(text, /Policy and settings inherit from source cwd/);
  assert.match(text, /not permissions or execution evidence/);
  assert.match(text, /declarations grant no permissions/);
  assert.doesNotMatch(text, /Relative.*use.*source cwd|Start without tree|Exclusive/);
  assert.ok(text.includes(`\n${JSON.stringify(dispatch)}\n--- End of dispatch declarations ---`), "literal declarations are not relocated");
  assert.equal(process.cwd(), cwd, "rendering changes no execution cwd");
});

test("shared dispatch defaults source inheritance to execution cwd; absent dispatch has no preface", () => {
  const cwd = "/shared/project";
  assert.equal(dispatchText({ tree: "build" }, cwd), dispatchText({ tree: "build" }, cwd, cwd));
  assert.equal(dispatchText(undefined, "/actual/execution", "/admitted/source"), "");
});
