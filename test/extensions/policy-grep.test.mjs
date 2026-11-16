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

after(() => disposePolicyGrepFixture());

test("policy grep owns its schema object and never mutates the shared nested SDK schema", async () => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const reference = sdk.createGrepToolDefinition(process.cwd());
  const before = JSON.stringify(reference.parameters);
  const tool = registerPolicyGrepTool();
  assert.equal(tool.name, "grep");
  assert.notEqual(tool.parameters, reference.parameters);
  assert.equal(tool.parameters.properties, reference.parameters.properties);
  // No new rejection machinery in the schema.
  assert.equal(reference.parameters.properties.limit.maximum, undefined);
  assert.equal(reference.parameters.properties.context.maximum, undefined);
  allowSession();
  const dir = mkdtempSync(join(tmpdir(), "policy-grep-schema-"));
  try {
    writeFileSync(join(dir, "a.txt"), "alpha one\nbeta two\nalpha three\n");
    await search(tool, dir, { pattern: "alpha" });
    assert.equal(JSON.stringify(reference.parameters), before);
    assert.equal(JSON.stringify(tool.parameters), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool description states the caps and normalization", () => {
  const tool = registerPolicyGrepTool();
  assert.match(tool.description, /floored and clamped to 1-500 \(default 100\)/);
  assert.match(tool.description, /floored and clamped to 0-10 \(default 0\)/);
  assert.match(tool.description, /50 KiB/);
  assert.match(tool.description, /30 second work budget/);
});

test("normal unchanged inputs search without normalization or cap notes", async () => {
  const tool = registerPolicyGrepTool();
  allowSession();
  const dir = mkdtempSync(join(tmpdir(), "policy-grep-normal-"));
  try {
    writeFileSync(join(dir, "a.txt"), "alpha one\nbeta two\nalpha three\nALPHA four\n");
    const { text, details } = await search(tool, dir, {
      pattern: "alpha",
      ignoreCase: true,
      limit: 5,
      context: 1,
    });
    assert.match(text, /1: alpha one/);
    assert.match(text, /2- beta two/);
    assert.match(text, /3: alpha three/);
    assert.match(text, /4: ALPHA four/);
    assert.doesNotMatch(text, /Requested limits normalized/);
    assert.doesNotMatch(text, /match limit \d+ reached/);
    assert.doesNotMatch(text, /output cap reached/);
    assert.doesNotMatch(text, /Search incomplete/);
    assert.equal(details.incomplete, false);
    // Boundary values inside the caps are also left unnormalized.
    const boundary = await search(tool, dir, { pattern: "alpha", limit: 500, context: 10 });
    assert.doesNotMatch(boundary.text, /Requested limits normalized/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
