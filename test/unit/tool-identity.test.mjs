import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { visibleWidth } from "@earendil-works/pi-tui";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { identifyingToolArgs, relativeToolPath } = await jiti.import(
  "../../src/orchestration/presentation/tool-identity.ts",
);
const { describeToolArgs } = await jiti.import("../../src/orchestration/ui/format.ts");

const cwd = "/fixture/project";
for (const [name, args, expected] of [
  ["read", { path: `${cwd}/src/main.ts` }, "src/main.ts"],
  ["edit", { path: "/outside/main.ts" }, "/outside/main.ts"],
  ["write", { path: "relative.ts" }, "relative.ts"],
  ["ls", {}, "."],
  ["bash", { command: "printf 'hello'\nnext" }, "printf 'hello'\\nnext"],
  ["grep", { pattern: "needle", path: `${cwd}/src` }, '"needle" in src'],
  ["find", { pattern: "*.ts", glob: "**/src" }, '"*.ts" in **/src'],
  ["ask_parent", { question: "which\nversion?" }, "which\\nversion?"],
  ["alert_parent", { message: "one\ttwo" }, "one\\x09two"],
  ["notify_parent", { message: "unsupported tool" }, undefined],
  ["unknown", { command: "not an identifying argument" }, undefined],
  ["read", { path: 42 }, undefined],
  ["bash", null, undefined],
])
  test(`neutral identifying preview preserves ${name} argument semantics: ${expected}`, () => {
    assert.equal(identifyingToolArgs(name, args, cwd), expected);
    assert.equal(describeToolArgs(name, args, cwd, Infinity), expected);
  });

test("identifying paths escape independently and do not confuse literal cwd prefixes", () => {
  assert.equal(relativeToolPath(`${cwd}-other/file.ts`, cwd), `${cwd}-other/file.ts`);
  assert.equal(
    relativeToolPath(`${cwd}/\u001b[31mfile.ts\u001b[0m`, cwd),
    "\\x1b[31mfile.ts\\x1b[0m",
  );
  assert.equal(relativeToolPath(`${cwd}/one\ntwo.ts`, cwd), "one\\ntwo.ts");
  assert.equal(relativeToolPath(`${cwd}/one\ttwo.ts`, cwd), "one\\x09two.ts");
  assert.equal(relativeToolPath(`${cwd}/one\u00a0\u3000two.ts`, cwd), "one\u00a0\u3000two.ts");
  const rawCwd = "/fixture/\x1b[31m\troot\\name";
  assert.equal(relativeToolPath(`${rawCwd}/file.ts`, rawCwd), "file.ts");
  assert.equal(
    relativeToolPath("/fixture/root/file.ts", "/fixture/\x1b[31mroot"),
    "/fixture/root/file.ts",
    "terminal sequences in cwd cannot disappear to create a false prefix",
  );
  assert.equal(
    relativeToolPath(`${cwd}/one\\ntwo.ts`, cwd),
    "one\\\\ntwo.ts",
    "literal escape spellings remain distinct from control characters",
  );
});

for (const [kind, command, expected] of [
  ["malformed CSI", "echo safe\x1b[actualcommand tail", "echo safe\\x1b[actualcommand tail"],
  ["unfinished CSI", "echo safe\x1b[123;", "echo safe\\x1b[123;"],
  ["OSC BEL", "echo safe\x1b]0;actualcommand\x07 tail", "echo safe\\x1b]0;actualcommand\\x07 tail"],
  ["unfinished OSC", "echo safe\x1b]0;actualcommand tail", "echo safe\\x1b]0;actualcommand tail"],
  [
    "OSC ST",
    "echo safe\x1b]0;actualcommand\x1b\\ tail",
    "echo safe\\x1b]0;actualcommand\\x1b\\\\ tail",
  ],
])
  test(`source compact arguments retain ${kind} command payloads`, () => {
    assert.equal(identifyingToolArgs("bash", { command }, cwd), expected);
    assert.equal(describeToolArgs("bash", { command }, cwd, Infinity), expected);
  });

test("search arguments escape raw fragments exactly once before joining", () => {
  for (const name of ["grep", "find"]) {
    const args = { pattern: "a\\b\t\u00a0\u3000", path: `${cwd}/dir\\name/\x1b[31mfile` };
    const expected = '"a\\\\b\\x09\u00a0\u3000" in dir\\\\name/\\x1b[31mfile';
    assert.equal(identifyingToolArgs(name, args, cwd), expected);
    assert.equal(describeToolArgs(name, args, cwd, Infinity), expected);
    assert(visibleWidth(describeToolArgs(name, args, cwd, 14)) <= 14);
    const globArgs = { pattern: "a\nb", glob: "dir\\name/\t*" };
    const globExpected = '"a\\nb" in dir\\\\name/\\x09*';
    assert.equal(identifyingToolArgs(name, globArgs, cwd), globExpected);
    assert.equal(describeToolArgs(name, globArgs, cwd, Infinity), globExpected);
  }
});

test("paint width is separate from unabridged observation identity", () => {
  const args = { path: `${cwd}/long-directory/another-directory/文件.ts` };
  const identity = identifyingToolArgs("read", args, cwd);
  const painted = describeToolArgs("read", args, cwd, 12);
  assert.equal(identity, "long-directory/another-directory/文件.ts");
  assert(visibleWidth(painted) <= 12);
  assert.notEqual(painted, identity);
});
