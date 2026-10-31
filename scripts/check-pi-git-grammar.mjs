#!/usr/bin/env node
// Source-only grammar/tokenizer checks: no build, repositories, Git execution,
// model requests or permission approvals. Not a complete managed-gate proof.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const grammarPath = fileURLToPath(new URL("../extensions/lib/git-read-grammar.ts", import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false });
const grammar = await jiti.import(grammarPath);
const { inspectGitCommands } = await jiti.import(
  fileURLToPath(new URL("../extensions/static-safety-guard.ts", import.meta.url)),
);
assert(!/^\s*import\b/m.test(readFileSync(grammarPath, "utf8")), "Shared grammar must stay import-free");
assert.deepEqual([...grammar.gitStatusFlags], [
  "-s", "-b", "-sb", "-bs", "-z", "-uno", "-unormal", "-uall", "--short", "--branch",
  "--porcelain", "--porcelain=v1", "--porcelain=v2",
  "--untracked-files=no", "--untracked-files=normal", "--untracked-files=all",
  "--ignored", "--ignored=matching", "--ignored=traditional", "--ignore-submodules=all",
]);
let grammarCases = 0;
function values(name, accepted, rejected) {
  for (const value of accepted) { assert.equal(grammar[name](value), true, `${name}: ${JSON.stringify(value)}`); grammarCases++; }
  for (const value of rejected) { assert.equal(grammar[name](value), false, `${name}: ${JSON.stringify(value)}`); grammarCases++; }
}
values("gitPrettyValue", [
  "medium", "short", "full", "fuller", "raw", "oneline", "reference",
  "%H %h %T %t %P %p %an %ae %ad %aD %ar %at %ai %aI %cn %ce %cd %cr %ct %ci %cI %s %f %b %B %N %D %n %%",
  "format:%H%x09%s",
  "%gD %gd %gn %ge %gs", "%%G?", "format:literal", "tformat:literal", "format:", "tformat:",
  "format:%H %P %s", "tformat:%h %ad %s", "owner's %s", "%%x00 %%C(red) %%<(20) %%(trailers)",
], [
  "review", "default", "ful", "Fuller", "", "%G?", "%GG", "%GS", "%GK", "%GF", "%GP", "%GT",
  "format:%G?", "tformat:%G?", "%x00", "%x1b", "%C(red)", "%Cred", "%<(20)", "%>(20)", "%|(20)",
  "%(trailers)", "%g?", "%gN", "%gE", "%Q", "%", "%%%G?", "%+s", "%-s", "% s",
  "%s\n", "%s\r", "%s\t", "%s\0", "%s\x1b", "%s\x7f", "%s\x85", "%s\u2028", "%s\u2029",
]);
values("gitDateValue", [
  "iso", "iso-local", "iso-strict", "iso8601", "iso8601-local", "rfc", "short", "raw", "relative", "default", "human", "unix",
  "format:%Y-%m-%d %H:%M:%S %z", "format-local:%Y %m", "format:%% %F %T %R %D %s",
  "format:%a %A %b %B %e %I %p %Z %j %u %w %U %W %V %G %g %y", `format:${"Y".repeat(256)}`,
], [
  "review", "ISO", "", "format:", "format-local:", `format:${"Y".repeat(257)}`, "format:%", "format:%n", "format:%t",
  "format:%Q", "format:%EY", "format:%Od", "format:%4Y", "format:%_d", "format:%-d", "format:%:z",
  "format:%Y\n", "format:%Y\r", "format:%Y\t", "format:%Y\0", "format:%Y\x1b", "format:%Y\x85", "format:%Y\u2028", "format:$Y",
]);
values("gitLogRevision", [
  "HEAD", "HEAD~5..HEAD", "main...topic", "^main", "^HEAD~2", "@{u}", "HEAD^{commit}", "refs/heads/topic", "deadbeef",
], ["", "^", "^^main", "--all", "-main", "HEAD:file", ":0:file", "main topic", "$REF", "HEAD\n", "HEAD\0"]);
values("gitDiffRevision", [
  "HEAD", "HEAD~1", "main^0", "refs/heads/topic", "deadbeef", "HEAD^", "HEAD~", "HEAD^^", "deadbeef^", "main~2^",
], ["^main", "main..topic", "main...topic", "@{u}", "HEAD^{commit}", "HEAD^{}", "HEAD^!", "HEAD^@", "HEAD^-", "HEAD^-1",
  "HEAD:file", "--cached", "HEAD\n", "HEAD\0"]);
values("gitPathWord", [
  ".", "./file.txt", "a path/file-name.txt", ".env", "./-file", "dir/file", "a...b", "docs/\u6ce8.txt",
], ["", "-file", "../file", "dir/../file", "/absolute", " file", "file ", ":(literal)file", "dir/*", "$PATH", "file\n", "file\0"]);

const optionCases = [
  ...["--oneline", "--no-decorate", "--decorate", "--decorate=short", "--decorate=full", "--no-walk", "--no-patch", "-s",
    "--not", "--graph", "--topo-order", "--date-order", "--reverse", "--no-show-signature", "--no-ext-diff", "--no-textconv",
    "-1", "-999", "-n5", "--max-count=5", "--format=fuller", "--pretty=raw", "--format=%H %P %s", "--pretty=tformat:%s",
    "--format=%%G?", "--date=iso-local", "--date=format-local:%Y %m"].map(arg => [[arg], 1]),
  [["-n", "5"], 2], [["--max-count", "999"], 2],
  ...["-0", "-1000", "-n0", "--max-count=1000", "--format=review", "--pretty=review", "--format=%G?", "--pretty=%x00",
    "--date=format:%n", "--date=review", "--patch", "--output=fixture", "--ext-diff", "--textconv", "--all", "--", "--oneline\n",
    "-5\n", "--max-count=5\n", "--format=%s\0"].map(arg => [[arg], 0]),
  [["-n"], 0], [["-n", "5\n"], 0], [["--max-count", "0"], 0], [["--format"], 0], [["--pretty"], 0], [["--date"], 0],
  [["--format", "--no-patch"], 0], [["--pretty", "review"], 0], [["--date", "format:%t"], 0],
  [["--format", "%H %P %s"], 0], [["--pretty", "format:literal"], 0], [["--date", "iso"], 0], [["--pretty", "raw"], 0], [[], 0],
];
for (const [args, length] of optionCases) {
  assert.equal(grammar.gitHistoryOptionLength(args, 0), length, JSON.stringify(args));
  assert.equal(grammar.gitHistoryOptionLength(["prefix", ...args], 1), length, `Nonzero index: ${JSON.stringify(args)}`);
  assert.equal(grammar.gitHistoryOptionProblem(args, 0) === undefined, length > 0, `Diagnostic agreement: ${JSON.stringify(args)}`);
  grammarCases++;
}
assert.match(grammar.gitPrettyProblem("%G?"), /%G\?.*signature/);
assert.match(grammar.gitPrettyProblem("review"), /named.*review/);
assert.match(grammar.gitPrettyProblem("%x00"), /byte escape/);
assert.match(grammar.gitDateProblem("format:%n"), /%n/);
// The strict legacy pretty whitelist and signature inventory are syntax only.
// Neither grants repository Git permission; all such commands use normal review.
for (const value of ["%x00%C(red)%<(20)%Q", "format:arbitrary output", "%%G?", "%x25G?"]) {
  assert.equal(grammar.gitPrettySignatureRequested(value), false, value);
  grammarCases++;
}
for (const value of ["%G?", "format:%GG", "tformat:%+GS", "%-GK", "% G?"]) {
  assert.equal(grammar.gitPrettySignatureRequested(value), true, value);
  grammarCases++;
}

let tokenizerCases = 0;
for (const [source, expected] of [
  ["git log --format='%H %P %s' abc..topic", ["--format=%H %P %s", "abc..topic"]],
  ["git log --date=format:'%Y %m'", ["--date=format:%Y %m"]],
  ['git log --pretty="owner\'s %s"', ["--pretty=owner's %s"]],
  ["git log '--pretty=owner'\\''s %s'", ["--pretty=owner's %s"]],
  ["git log --format='%H'\" %s\"", ["--format=%H %s"]],
  ["git log -- 'docs/a b.txt'", ["--", "docs/a b.txt"]],
  ["env git log --format='%H %s'", ["--format=%H %s"]],
]) {
  const [invocation] = inspectGitCommands(source);
  assert.deepEqual(invocation?.args, expected, source);
  assert.equal(invocation?.expansions, false, source);
  assert.equal(invocation?.wrapped, source.startsWith("env "), source);
  tokenizerCases++;
}
for (const source of ['git log --format="$FORMAT"', 'git log --format="$(echo %s)"', 'git log --format="`echo %s`"']) {
  assert(inspectGitCommands(source).some(invocation => invocation.expansions), source);
  tokenizerCases++;
}

// Required DATA may look like another option; roles do not confer query
// eligibility. Optional pretty/color arguments must not swallow real outputs.
for (const [sub, option, role] of [
  ["log", "--grep", "data"], ["show", "--author", "data"],
  ["branch", "--format", "data"], ["tag", "--sort", "data"],
  ["log", "--output", "output"], ["diff", "--output", "output"],
  ["archive", "--output", "output"], ["archive", "--prefix", "data"],
  ["log", "--pretty", undefined], ["log", "--format", undefined], ["branch", "--color", undefined],
]) {
  assert.equal(grammar.gitRequiredOperandRole(sub, option), role, `${sub}/${option}`);
  grammarCases++;
}

let mutationCases = 0;
for (const [sub, args, pattern] of [
  ["branch", ["topic"], /creation/], ["tag", ["v1"], /creation/],
  ["branch", ["-m", "old", "new"], /mutation/], ["branch", ["-D", "-f", "old"], /mutation/],
  ["tag", ["-d", "v1"], /mutation/], ["tag", ["-a", "v1", "-m", "fixture"], /mutation/],
  ["commit", ["-a", "-m", "fixture"], /mutation|configuration/], ["checkout", ["-b", "topic"], /mutation|configuration/],
  ["commit", ["--amend"], /mutation|configuration/],
  ["branch", ["--del", "topic"], /mutation/], ["tag", ["--del", "v1"], /mutation/],
  ["branch", ["-vD", "topic"], /mutation/], ["tag", ["-ld", "v1"], /mutation/],
  ["tag", ["-vd", "v1"], /mutation/], ["branch", ["-v", "new"], /creation/],
  ["branch", ["--format", "--list", "topic"], /creation/],
  ["tag", ["--sort", "--list", "v1"], /creation/],
  ["symbolic-ref", ["--del", "HEAD"], /modification/], ["replace", ["--del", "HEAD"], /modification/],
]) {
  assert.match(grammar.gitMutationProblem(sub, args) ?? "", pattern, `${sub} ${args.join(" ")}`);
  mutationCases++;
}
for (const [sub, args] of [
  ["branch", ["--list"]], ["branch", ["-v"]], ["tag", ["--list"]], ["status", ["--short", "-z"]],
  ["branch", ["--format", "%(refname:short)"]], ["tag", ["--sort", "refname"]],
  ["branch", ["--format", "-D"]], ["tag", ["--sort", "--delete"]],
  // Verification can invoke GPG: undefined here means ordinary analysis, NOT
  // automatic permission. Never execute a verifier in this pure grammar lane.
  ["tag", ["-v", "v1"]], ["tag", ["--verify", "v1"]],
  ["log", ["--not-a-real-option"]], ["diff", ["--output=fixture"]],
]) {
  assert.equal(grammar.gitMutationProblem(sub, args), undefined, `Not a mutation deny: ${sub} ${args.join(" ")}`);
  mutationCases++;
}
const guardSource = readFileSync(fileURLToPath(new URL("../extensions/static-safety-guard.ts", import.meta.url)), "utf8");
assert.doesNotMatch(guardSource, /gitMutationProblem/, "effect inventory must not become a child-only static Git refusal");
console.log(`PASS: ${grammarCases} grammar, ${tokenizerCases} static-tokenizer, ${mutationCases} mutation-inventory cases (source-only; inventory is not an approval or child refusal)`);
