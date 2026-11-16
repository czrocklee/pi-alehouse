import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowSession,
  disposePolicyGrepFixture,
  registerPolicyGrepTool,
  search,
} from "../support/policy-grep-fixture.mjs";

function matchLines(text) {
  return [...text.matchAll(/^(\d+): /gm)].length;
}

const dir = mkdtempSync(join(tmpdir(), "policy-grep-limits-"));
const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("\n");
// 600 matches: enough to prove the 500 cap with limit 1000 requested.
writeFileSync(join(dir, "many.txt"), `${lines(600, () => "alpha")}\n`);
// One match surrounded by enough lines to observe the effective context window.
writeFileSync(join(dir, "spread.txt"), `${lines(40, (index) => `filler ${index + 1}`)}\n`);
// Long matching lines: the 50 KiB result cap is reached long before any
// match-count or work limit.
writeFileSync(join(dir, "wide.txt"), `${lines(300, () => `needle ${"x".repeat(593)}`)}\n`);
// One 2 MiB line with ~190k matches: ripgrep reports every submatch of a line
// in one JSON event, so the subprocess output cap trips during scan work while
// the reported match count and result output stay small.
writeFileSync(join(dir, "huge.txt"), `${"needlexxxxx".repeat(190649)}`);

after(() => {
  rmSync(dir, { recursive: true, force: true });
  disposePolicyGrepFixture();
});

test("limit 1000 normalizes to 500 and the match cap is reported in the content", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const { text, details } = await search(tool, dir, {
    pattern: "alpha",
    path: "many.txt",
    limit: 1000,
  });
  assert.match(text, /Requested limits normalized: limit 500 \(requested 1000\)\./);
  assert.match(
    text,
    /Search incomplete: match limit 500 reached; additional matches were not returned/,
  );
  assert.equal(matchLines(text), 500);
  assert.doesNotMatch(text, /output cap reached/);
  assert.doesNotMatch(text, /work or scan limit/);
  assert.equal(details.incomplete, true);
});

test("context 20 normalizes to 10 and the effective window is applied", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const { text, details } = await search(tool, dir, {
    pattern: "filler 20",
    path: "spread.txt",
    context: 20,
  });
  assert.match(text, /Requested limits normalized: context 10 \(requested 20\)\./);
  assert.match(text, /^10- filler 10$/m);
  assert.doesNotMatch(text, /^9- filler 9$/m);
  assert.match(text, /^30- filler 30$/m);
  assert.doesNotMatch(text, /^31- filler 31$/m);
  assert.doesNotMatch(text, /match limit \d+ reached/);
  assert.equal(details.incomplete, false);
});

test("fractional and negative requested values are floored and normalized in the content", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const floored = await search(tool, dir, { pattern: "alpha", path: "many.txt", limit: 2.9 });
  assert.match(floored.text, /Requested limits normalized: limit 2 \(requested 2\.9\)\./);
  assert.equal(matchLines(floored.text), 2);
  assert.match(
    floored.text,
    /Search incomplete: match limit 2 reached; additional matches were not returned/,
  );

  const negative = await search(tool, dir, { pattern: "alpha", path: "many.txt", limit: -5 });
  assert.match(negative.text, /Requested limits normalized: limit 1 \(requested -5\)\./);
  assert.equal(matchLines(negative.text), 1);

  const noContext = await search(tool, dir, {
    pattern: "filler 20",
    path: "spread.txt",
    context: -3,
  });
  assert.match(noContext.text, /Requested limits normalized: context 0 \(requested -3\)\./);
  assert.match(noContext.text, /^20: filler 20$/m);
  assert.doesNotMatch(noContext.text, /^19- /m);

  const floorContext = await search(tool, dir, {
    pattern: "filler 20",
    path: "spread.txt",
    context: 2.7,
  });
  assert.match(floorContext.text, /Requested limits normalized: context 2 \(requested 2\.7\)\./);
  assert.match(floorContext.text, /^18- filler 18$/m);
  assert.doesNotMatch(floorContext.text, /^17- filler 17$/m);
});

test("the match-count cap is reported separately from the result output cap", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const matchCapped = await search(tool, dir, { pattern: "alpha", path: "many.txt", limit: 2 });
  assert.match(
    matchCapped.text,
    /Search incomplete: match limit 2 reached; additional matches were not returned/,
  );
  assert.doesNotMatch(matchCapped.text, /output cap reached/);
  assert.doesNotMatch(matchCapped.text, /work or scan limit/);

  const outputCapped = await search(tool, dir, { pattern: "needle", path: "wide.txt", limit: 500 });
  assert.match(
    outputCapped.text,
    /Search incomplete: output cap reached; results were truncated at 50 KiB/,
  );
  assert.doesNotMatch(outputCapped.text, /match limit \d+ reached/);
  assert.doesNotMatch(outputCapped.text, /work or scan limit/);
  assert.equal(outputCapped.details.incomplete, true);
});

test("simultaneous match and output caps promise no specific displayed match count", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  // 100 match lines of ~533 bytes each exceed the 50 KiB result cap before all
  // 100 admitted matches are written, while the 101st match trips the cap.
  const { text, details } = await search(tool, dir, {
    pattern: "needle",
    path: "wide.txt",
    limit: 100,
  });
  assert.match(text, /Search incomplete: match limit 100 reached/);
  assert.match(text, /Search incomplete: output cap reached; results were truncated at 50 KiB/);
  assert.doesNotMatch(text, /showing the first/);
  const displayed = matchLines(text);
  assert.equal(displayed > 0 && displayed < 100, true);
  assert.equal(details.incomplete, true);
});

test("scan work limits are reported separately from the match-count cap", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const { text, details } = await search(tool, dir, {
    pattern: "needle",
    path: "huge.txt",
    limit: 500,
  });
  assert.match(
    text,
    /Search incomplete: a scan limit was reached \(file count, scanned bytes or ripgrep output cap\)/,
  );
  // A timeout abort throws instead of returning a partial result, so the
  // partial-result note must never claim a 30 second budget was reached.
  assert.doesNotMatch(text, /30 second/);
  assert.doesNotMatch(text, /match limit \d+ reached/);
  assert.equal(matchLines(text) < 500, true);
  assert.equal(details.incomplete, true);
  // The 30 second budget stays documented in the tool description itself.
  assert.match(tool.description, /30 second work budget/);
});

test("match-limit advice is conditional on the effective limit already being the maximum", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  // Below the cap: raising the limit is still possible.
  const raisable = await search(tool, dir, { pattern: "alpha", path: "many.txt", limit: 100 });
  assert.match(raisable.text, /Search incomplete: match limit 100 reached/);
  assert.match(raisable.text, /Raise limit \(caps at 500\) or narrow the search\./);

  // At the cap: no impossible advice; only narrowing remains.
  const maximum = await search(tool, dir, { pattern: "alpha", path: "many.txt", limit: 500 });
  assert.match(maximum.text, /Search incomplete: match limit 500 reached/);
  assert.doesNotMatch(maximum.text, /Raise limit/);
  assert.match(maximum.text, /The limit is already at the maximum of 500; narrow path\/glob\./);
  assert.doesNotMatch(maximum.text, /Requested limits normalized/);
  assert.equal(matchLines(maximum.text), 500);
});
