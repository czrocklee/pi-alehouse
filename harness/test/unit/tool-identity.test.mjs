import assert from "node:assert/strict";
import test from "node:test";
import { identifyingToolArgs, relativeToolPath } from "../../dist/presentation/tool-identity.js";
import { describeToolArgs } from "../../dist/ui/format.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const cwd = "/fixture/project";
for (const [name, args, expected] of [
  ["read", { path: `${cwd}/src/main.ts` }, "src/main.ts"],
  ["edit", { path: "/outside/main.ts" }, "/outside/main.ts"],
  ["write", { path: "relative.ts" }, "relative.ts"],
  ["ls", {}, "."],
  ["bash", { command: "printf 'hello'\nnext" }, "printf 'hello' next"],
  ["grep", { pattern: "needle", path: `${cwd}/src` }, '"needle" in src'],
  ["find", { pattern: "*.ts", glob: "**/src" }, '"*.ts" in **/src'],
  ["ask_parent", { question: "which\nversion?" }, "which version?"],
  ["alert_parent", { message: "one\ttwo" }, "one two"],
  ["notify_parent", { message: "historical" }, "historical"],
  ["unknown", { command: "not an identifying argument" }, undefined],
  ["read", { path: 42 }, undefined],
  ["bash", null, undefined],
])
  test(`neutral identifying preview preserves ${name} argument semantics: ${expected}`, () => {
    assert.equal(identifyingToolArgs(name, args, cwd), expected);
    assert.equal(describeToolArgs(name, args, cwd, Infinity), expected);
  });

test("identifying paths sanitize independently and do not confuse cwd prefixes", () => {
  assert.equal(relativeToolPath(`${cwd}-other/file.ts`, cwd), `${cwd}-other/file.ts`);
  assert.equal(relativeToolPath(`${cwd}/\u001b[31mfile.ts\u001b[0m`, cwd), "file.ts");
  assert.equal(relativeToolPath(`${cwd}/one\ntwo.ts`, cwd), "one two.ts");
});

test("paint width is separate from unabridged observation identity", () => {
  const args = { path: `${cwd}/long-directory/another-directory/文件.ts` };
  const identity = identifyingToolArgs("read", args, cwd);
  const painted = describeToolArgs("read", args, cwd, 12);
  assert.equal(identity, "long-directory/another-directory/文件.ts");
  assert(visibleWidth(painted) <= 12);
  assert.notEqual(painted, identity);
});
