import assert from "node:assert/strict";
import test from "node:test";
import { dispatchText } from "../../dist/orchestration/core/dispatch.js";

// The internal Dispatch record shape stays internal; only this parent->child
// text is model-facing, so it prints the public vocabulary and nothing else.
const declaration = (text) =>
  JSON.parse(text.match(/\n(\{.*\})\n--- End of dispatch declarations ---/)[1]);

test("dispatch names the inherited cwd as its single relative-path base", () => {
  const cwd = '/parent/project "quoted"/line\nbreak';
  const dispatch = Object.freeze({
    inputs: Object.freeze(["src/input.ts", "../sibling.ts", "/explicit/file"]),
    ownership: Object.freeze(["src/output.ts"]),
    tree: "build",
    checks: Object.freeze(["focused check"]),
  });
  const original = process.cwd(),
    text = dispatchText(dispatch, cwd);
  assert(text.includes(`Execution cwd: ${JSON.stringify(cwd)}\n`));
  assert(!text.includes(cwd), "cwd is JSON encoded, not interpolated raw");
  assert.match(
    text,
    /Relative required_paths, ownership, and build_dir paths resolve from this cwd/,
  );
  assert.match(text, /not permissions or execution evidence/);
  assert.match(text, /declarations grant no permissions/);
  assert.doesNotMatch(text, /source cwd|binding|worktree|Exclusive/);
  assert.deepEqual(declaration(text), {
    required_paths: ["src/input.ts", "../sibling.ts", "/explicit/file"],
    ownership: ["src/output.ts"],
    build_dir: "build",
    checks: ["focused check"],
  });
  assert(!/"inputs"|"tree"|\binputs\b/.test(text), "no internal field name is printed");
  assert.equal(process.cwd(), original, "rendering changes no execution cwd");
  assert.equal(dispatchText(undefined, cwd), "");
});

test("dispatch prints only declared fields, in the fixed public order", () => {
  const text = dispatchText({ checks: ["focused"] }, "/parent/project");
  assert.deepEqual(declaration(text), { checks: ["focused"] });
  const full = dispatchText(
    { inputs: ["in"], ownership: ["out"], tree: "build", checks: ["focused"] },
    "/parent/project",
  );
  assert.equal(
    JSON.stringify(Object.keys(declaration(full))),
    JSON.stringify(["required_paths", "ownership", "build_dir", "checks"]),
  );
});
