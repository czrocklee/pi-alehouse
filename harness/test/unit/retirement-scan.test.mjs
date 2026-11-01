// Source/documentation drift guard, not an exhaustive semantic review or a
// replacement for runtime lifecycle, history, permission and schema tests.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function files(root, extension) {
  const found = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        assert(entry.isFile(), `Review non-regular source input: ${path}`);
        if (entry.name.endsWith(extension)) found.push({ name: relative(root, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") });
      }
    }
  }
  visit(root); return found;
}
const sources = files(fileURLToPath(new URL("../../src/", import.meta.url)), ".ts");

test("retired execution timers, metadata modes and recovery implementation cannot return to live source", () => {
  const retired = /\b(?:max_duration_ms|softTimeBudgetMessage|softDeadlineDelay|timeWrapUp|budgetStartedMono|deadlineTimer|softDeadlineTimer|softDeadlineDue|SOFT_TIME_MESSAGE_REJECTED|earlier_labels|touched_omitted|recovery_hint|WORKTREE_TREE_RESOLUTION|DISPATCH_WORKTREE_UNINITIALIZED)\b|\bm1_/;
  for (const source of sources) assert.doesNotMatch(source.text, retired, source.name);
  assert(!sources.some(source => source.name === "core/model-recovery.ts"), "no retired hint implementation");
});

test("timed-warning fields remain only in historical outcome/receipt types and journal codecs", () => {
  const allowed = ["core/contracts.ts", "core/dispatch.ts", "history/history-reader.ts", "history/run-journal.ts"];
  assert.deepEqual(sources.filter(source => /\btime_wrapped\b/.test(source.text)).map(source => source.name).sort(), allowed.sort(),
    "new live producers/projections need review; historical codecs must remain readable");
});

test("Markdown guides cannot reintroduce retired operational instructions or schema drafts", () => {
  const docs = files(fileURLToPath(new URL("../../docs/", import.meta.url)), ".md");
  for (const path of ["../../README.md", "../../../README.md"])
    docs.push({ name: path, text: readFileSync(new URL(path, import.meta.url), "utf8") });
  // Negative/migration explanations and literal history remain legitimate;
  // these are obsolete positive instructions, not a ban on compatibility words.
  const obsolete = /\bDefault Run execution deadline\b|\beight (?:fixed harness management tools|parent tools)\b|\bsix (?:worker|agent) definitions\b|Relative paths use source cwd even in worktree|For worktree, omit until initialized|Start without tree; (?:once|after) initializ|\bmax_duration_ms\s*:\s*(?:optional|Type\.)/i;
  for (const doc of docs) assert.doesNotMatch(doc.text, obsolete, doc.name);
});
