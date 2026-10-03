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
const { inspectGitCommands, staticGitQueryProblem } = await jiti.import(
  fileURLToPath(new URL("../extensions/static-safety-guard.ts", import.meta.url)),
);
assert(!/^\s*import\b/m.test(readFileSync(grammarPath, "utf8")), "Shared grammar must stay import-free");
assert.deepEqual([...grammar.gitStatusFlags], [
  "-s", "-b", "--short", "--branch", "--porcelain", "--porcelain=v1", "--porcelain=v2",
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
  "%H %h %T %t %P %p %an %ae %ad %aD %ar %at %ai %aI %cn %ce %cd %cr %ct %ci %cI %s %f %b %N %D %n %%",
  "%gD %gd %gn %ge %gs", "%%G?", "format:literal", "tformat:literal", "format:", "tformat:",
  "format:%H %P %s", "tformat:%h %ad %s", "owner's %s", "%%x00 %%C(red) %%<(20) %%(trailers)",
], [
  "review", "default", "ful", "Fuller", "", "%G?", "%GG", "%GS", "%GK", "%GF", "%GP", "%GT",
  "format:%G?", "tformat:%G?", "%x00", "%C(red)", "%Cred", "%<(20)", "%>(20)", "%|(20)",
  "%(trailers)", "%g?", "%gN", "%gE", "%B", "%Q", "%", "%%%G?", "%+s", "%-s", "% s",
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
  "HEAD", "HEAD~1", "main^0", "refs/heads/topic", "deadbeef",
], ["^main", "main..topic", "main...topic", "HEAD^", "@{u}", "HEAD^{commit}", "HEAD:file", "--cached", "HEAD\n", "HEAD\0"]);
values("gitPathWord", [
  ".", "./file.txt", "a path/file-name.txt", ".env", "./-file", "dir/file", "a...b",
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

let staticCases = 0;
for (const source of [
  "git status --short", "git status --short --ignored -- literal.txt", "git status --short --ignore-submodules=all",
  "git log -- path", "git log HEAD -- docs/file.md './-file' 'docs/a b.txt' .env", "git log -- ./file dir/file",
  "git log -5 --oneline", "git log --format=fuller",
  "git log --format='%H %P %s' main..topic", "git log --pretty='%h %ad %s' --date=iso-local -6", "git log --format='%%G?'",
  "git log --date=format:'%Y %m'", "git log '--format=%H %P %s' --pretty=raw --date=iso", "git log ^main --not topic --",
  "git log --graph --topo-order --date-order --reverse --decorate=full main...topic", "git log HEAD '@{u}' ^main",
  "git log --no-show-signature --no-ext-diff --no-textconv", "git show -s HEAD^0", "git show --no-patch main^{commit}",
  "git show -s --format='%h %s' --date=iso-local HEAD^{commit}",
  "env git show HEAD:file", "timeout 5 git show HEAD:file", "env git log -- path", "env git log --format=review",
  "git diff --output=fixture -- path", "git ls-files --unknown", "git -P diff --textconv", "git config fixture value",
]) {
  assert.equal(staticGitQueryProblem(source), undefined, source);
  staticCases++;
}
for (const [source, diagnostic] of [
  ["git log --format=review", /named.*review/], ["git log --pretty=review", /named.*review/],
  ["git log --format='%G?'", /%G\?.*signature/], ["git log --pretty='%x00'", /byte escape/],
  ["git log --format='%C(red)'", /color/], ["git log --format='%<(20)'", /width/], ["git log --format='%(trailers)'", /trailers/],
  ["git log --format='%g?'", /%g\?/], ["git log --format='%s\n'", /control|line break/],
  ["git log --date=format:%n", /%n/], ["git log --date=review", /date mode.*review/], ["git log --format", /literal value/],
  ["git log --max-count 1000", /1\.\.999/], ["git log --ext-diff", /--ext-diff/], ["git log --textconv", /--textconv/],
  ["git log --patch", /--patch/], ["git log --output=fixture", /--output=fixture/],
  ...["../file", "dir/../file", "/absolute", "-file", ":(literal)file", "dir/*", "$PATH", "file ", "file\n", "owner's file"].map(path =>
    [`git log -- valid.txt ${JSON.stringify(path)}`, /pathspec|shell expansion/]),
  ["git log -- valid.txt ''", /pathspec/], ["git show -s HEAD:file", /HEAD:file.*commit-constrained/],
  ["git show -s HEAD", /HEAD.*commit-constrained/], ["git show -s deadbeef", /deadbeef.*commit-constrained/],
  ["git show -s", /requires.*commit-constrained/], ["git show HEAD^0", /requires -s/], ["git show -s HEAD^0 --", /terminator/],
  ["git show -s --pretty raw HEAD^0", /--pretty.*attached/], ["git show -s --format raw HEAD^0", /--format.*attached/],
  ["git show -s --date iso HEAD^0", /--date.*attached/],
  ["git status --unknown", /status argument.*--unknown/],
  ...["--ignore-submodules", "--ignore-submodules=none", "--ignore-submodules=dirty", "--ignore-submodules=untracked", "--ignore-submodules=al"].map(flag =>
    [`git status ${flag}`, /status argument/]),
  ["git -c log.showSignature=true log", /configuration override/],
  ["git --unknown log", /global option/], ['git log "$REF"', /shell expansion/],
  ["git status --short; git log --format='%G?'", /signature/],
]) {
  assert.match(staticGitQueryProblem(source) ?? "", diagnostic, source);
  staticCases++;
}
console.log(`PASS: ${grammarCases} grammar, ${tokenizerCases} static-tokenizer, ${staticCases} static-query cases (source-only; no complete gate proof)`);
