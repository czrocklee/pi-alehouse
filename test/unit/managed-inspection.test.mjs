import assert from "node:assert/strict";
import test from "node:test";
import {
  managedStaticFileScope,
  originalGitCommands,
  recordManagedInput,
  requestedBashCommand,
} from "../../generated/authority/vendor/src/access-intent/bash/managed-inspection.ts";

test("missing or unrecorded invocation input has no managed provenance", () => {
  const command = "echo ordinary";
  const aliasInput = { script: command };
  for (const input of [aliasInput, {}, { command }, undefined, null]) {
    assert.equal(originalGitCommands(input), undefined);
    assert.equal(managedStaticFileScope(input), undefined);
  }
  assert.equal(requestedBashCommand(aliasInput, command), command);
  assert.equal(requestedBashCommand(null, command), undefined);
});

test("managed provenance requires the original input and exact execution spelling", () => {
  const source = "mkdir -p out";
  const command = "mkdir -p -- out";
  const input = { command: source };
  const scope = { command, marked: [true], accesses: [] };
  const unit = { text: source, words: ["mkdir", "-p", "out"], start: 0, end: source.length };
  recordManagedInput(input, source, command, [unit], scope);
  assert.deepEqual(originalGitCommands(input), [source]);
  assert.equal(managedStaticFileScope(input), scope);

  const copy = { ...input };
  delete input.command;
  for (const value of [copy, input]) {
    assert.equal(originalGitCommands(value), undefined);
    assert.equal(managedStaticFileScope(value), undefined);
  }
});
