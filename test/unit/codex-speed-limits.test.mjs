import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSpeedLimits } from "../../src/orchestration/runtime/codex-speed-limits.ts";

const FILE_NAME = "alehouse-codex-speeds.json";
const WARNING =
  "Invalid or unreadable alehouse-codex-speeds.json; Codex Fast and Ultrafast are disabled.";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "alehouse-codex-speeds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, FILE_NAME);
  return {
    dir,
    path,
    load: () => loadSpeedLimits(dir),
    write: (data) => writeFileSync(path, data),
  };
}

function inspectInChild(agentDir, cwd) {
  const module = new URL("../../src/orchestration/runtime/codex-speed-limits.ts", import.meta.url);
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
      import { loadSpeedLimits } from ${JSON.stringify(module.href)};
      const { limitFor, warning } = loadSpeedLimits(process.argv[1]);
      console.log(JSON.stringify({ speed: limitFor("openai-codex", "gpt-6.2-sol"), warning }));
    `,
      "--",
      agentDir,
    ],
    { cwd, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" },
  );
  return JSON.parse(output);
}

const nonCodex = [
  "openai",
  "alehouse-virtual",
  "openai-codex-1",
  "openai-codex-02",
  "openai-codex-2\n",
];

test("an absent file allows only the ten original Fast models on Codex", (t) => {
  const { limitFor, warning } = fixture(t).load();
  assert.equal(warning, undefined);
  const fastModels = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6.2-sol",
    "gpt-6.2-astra",
  ];
  for (const provider of ["openai-codex", "openai-codex-2", "openai-codex-10"]) {
    for (const model of fastModels) assert.equal(limitFor(provider, model), "fast", model);
    assert.equal(limitFor(provider, "gpt-6.3-new"), "normal");
    assert.equal(limitFor(provider, "gpt-6.2-sol\n"), "normal");
  }
  for (const provider of nonCodex)
    assert.equal(limitFor(provider, "gpt-6.2-sol"), "normal", provider);
});

test("a manual list replaces the defaults and an exact slot overrides the bare model", (t) => {
  const f = fixture(t);
  f.write(
    JSON.stringify({
      "gpt-6.2-sol": "ultrafast",
      "openai-codex/gpt-6.2-sol": "normal",
      "openai-codex-2/gpt-6.2-sol": "fast",
      "openai-codex-10/gpt-6.3-new": "ultrafast",
    }),
  );
  const { limitFor, warning } = f.load();
  assert.equal(warning, undefined);
  assert.equal(limitFor("openai-codex", "gpt-6.2-sol"), "normal");
  assert.equal(limitFor("openai-codex-2", "gpt-6.2-sol"), "fast");
  assert.equal(limitFor("openai-codex-3", "gpt-6.2-sol"), "ultrafast");
  assert.equal(limitFor("openai-codex-10", "gpt-6.3-new"), "ultrafast");
  assert.equal(limitFor("openai-codex-2", "gpt-6.3-new"), "normal");
  assert.equal(limitFor("openai-codex-3", "gpt-6.2-astra"), "normal", "do not merge the defaults");
  for (const provider of nonCodex)
    assert.equal(limitFor(provider, "gpt-6.2-sol"), "normal", provider);
  for (const model of [
    "GPT-6.2-sol",
    "openai-codex-2/gpt-6.2-sol",
    "toString",
    "__proto__",
    "constructor",
  ]) {
    assert.equal(limitFor("openai-codex-3", model), "normal", model);
  }
});

test("an empty object disables both speeds without a warning", (t) => {
  const f = fixture(t);
  f.write("{}");
  const { limitFor, warning } = f.load();
  assert.equal(warning, undefined);
  assert.equal(limitFor("openai-codex", "gpt-6.2-sol"), "normal");
});

test("allowance reminders apply only to a table with a possible accelerated request", (t) => {
  const f = fixture(t);
  assert.equal(f.load().allowsAcceleration, true, "built-in Fast table");
  for (const [json, expected] of [
    ["{}", false],
    ['{"gpt-6.2-astra":"normal"}', false],
    ['{"openai-codex-2/gpt-6.2-sol":"fast"}', true],
    ['{"openai-codex/gpt-6.2-sol":"ultrafast"}', true],
    ['{"gpt-6.2-sol":"fast","gpt-6.2-astra":"invalid"}', false],
  ]) {
    f.write(json);
    assert.equal(f.load().allowsAcceleration, expected, json);
  }
});

test("bad JSON, invalid shapes, invalid model keys and invalid limits all fail closed", (t) => {
  const f = fixture(t);
  const invalid = [
    "",
    '{"gpt-6.2-sol": "ultrafast",',
    "null",
    '"fast"',
    '["fast"]',
    ...[
      ["gpt-6.3-new", "private-input-do-not-echo"],
      ["gpt-6.3-new", { speed: "fast" }],
      ["gpt-6.3-new", 1],
      ["gpt-6.3-new", null],
      ["gpt-*", "fast"],
      ["openai/gpt-6.3-new", "fast"],
      ["alehouse-virtual/gpt-6.3-new", "fast"],
      ["openai-codex-1/gpt-6.3-new", "fast"],
      ["openai-codex-02/gpt-6.3-new", "fast"],
      ["openai-codex-2\n/gpt-6.3-new", "fast"],
      ["openai-codex/other/gpt-6.3-new", "fast"],
      ["openai-codex/", "fast"],
      ["gpt-6.3-new ", "fast"],
      ["", "fast"],
      ["__proto__", "fast"],
      ["constructor", "fast"],
      ["prototype", "fast"],
      ["toString", "fast"],
      ["openai-codex-2/constructor", "fast"],
    ].map(([key, value]) => JSON.stringify({ "gpt-6.2-sol": "ultrafast", [key]: value })),
  ];
  for (const data of invalid) {
    f.write(data);
    const { limitFor, warning } = f.load();
    assert.equal(warning, WARNING, JSON.stringify(data));
    assert.equal(limitFor("openai-codex", "gpt-6.2-sol"), "normal");
    assert.equal(limitFor("openai-codex-2", "gpt-6.2-astra"), "normal");
  }
});

test("look only in the supplied absolute agent directory, never in the project", (t) => {
  const f = fixture(t);
  const agentDir = join(f.dir, "user-agent");
  mkdirSync(agentDir);
  f.write('{"gpt-6.2-sol":"ultrafast"}');
  assert.deepEqual(inspectInChild(agentDir, f.dir), { speed: "fast" });
  assert.deepEqual(inspectInChild(".", f.dir), { speed: "normal", warning: WARNING });
});

test("regular-file symlinks work, while dangling and oversized targets fail closed", (t) => {
  const f = fixture(t);
  const target = join(f.dir, "managed-config.json");
  symlinkSync(target, f.path);
  assert.equal(f.load().warning, WARNING);
  const config = '{"gpt-6.2-sol":"ultrafast"}';
  writeFileSync(target, config);
  const { limitFor, warning } = f.load();
  assert.equal(warning, undefined);
  assert.equal(limitFor("openai-codex", "gpt-6.2-sol"), "ultrafast");
  writeFileSync(target, config + " ".repeat(64 * 1024));
  assert.equal(f.load().warning, WARNING);
  assert.equal(f.load().limitFor("openai-codex", "gpt-6.2-sol"), "normal");
});

test("a symlink to a FIFO fails closed without blocking", (t) => {
  const f = fixture(t);
  const fifo = join(f.dir, "fifo");
  execFileSync("mkfifo", [fifo], { timeout: 5_000 });
  symlinkSync(fifo, f.path);
  assert.deepEqual(inspectInChild(f.dir, f.dir), { speed: "normal", warning: WARNING });
});
