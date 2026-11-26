import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// Test-only oracle; the launcher must not depend on this private SDK module.
import { parseArgs } from "../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { scanLaunchOptions } from "../../bin/launch-options.mjs";

const flags = ["--no-skills", "-ns"];
const extensionOptions = ["-e", "--extension"];
const extensionSpellings = [
  ...extensionOptions,
  "--extension=path",
  "-eattached",
  "-e=path",
  "-example",
];
const valueOptions = [
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
];

function check(args, expected) {
  const argv = Object.freeze([...args]);
  const label = JSON.stringify(argv);
  assert.equal(parseArgs(argv).noSkills === true, expected, `Pi parser: ${label}`);
  assert.equal(scanLaunchOptions(argv).noSkills, expected, `launcher predicate: ${label}`);
  assert.deepEqual(argv, args, `argv must remain byte/order identical: ${label}`);
}

function checkExtensions(args, rejected, loadsExtension = false) {
  const argv = Object.freeze([...args]);
  const label = JSON.stringify(argv);
  assert.equal(
    (parseArgs(argv).extensions?.length ?? 0) > 0,
    loadsExtension,
    `Pi extension loading: ${label}`,
  );
  assert.equal(
    scanLaunchOptions(argv).additionalExtensions,
    rejected,
    `launcher extension screening: ${label}`,
  );
  assert.deepEqual(argv, args, `argv must remain byte/order identical: ${label}`);
}

test("launcher option parity targets the installed development Pi 1.6.1 parser", () => {
  const sdk = JSON.parse(
    readFileSync(
      new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(sdk.version, "1.6.1", "review the value-option inventory when upgrading Pi");
});

test("no-skills recognizes exact aliases, repeats and flags after positional messages", () => {
  check([], false);
  check(["prompt"], false);
  check(["@prompt.md"], false);
  for (const flag of flags) {
    check([flag], true);
    check([flag, flag], true);
    check(["prompt", flag], true);
    check(["@prompt.md", "prompt", flag], true);
    check(["--print", "prompt", flag], true);
    check(["prompt", flag, "another prompt"], true);
    check([flag, "--system-prompt", flag], true);
    check([`literal ${flag}`], false);
    check([`@${flag}`], false);
    check([`${flag}=false`], false);
    check([`${flag}=true`], false);
    check([`${flag}-suffix`], false);
    check([`prefix${flag}`], false);
  }
  check(["--no-skills", "-ns", "--no-skills"], true);
  check(["--NO-SKILLS"], false);
  check(["--no-skills", "-e", "path"], true);
  check(["--no-skills", "--", "-e", "path"], true);
});

test("an unconsumed separator stops no-skills recognition, including after messages", () => {
  for (const flag of flags) {
    check(["--", flag], false);
    check(["prompt", "--", flag], false);
    check(["--", "--system-prompt", "--", flag], false);
    check([flag, "--", flag], true);
    check(["--system-prompt", "--", flag], true);
    check(["--system-prompt", "--", "--", flag], false);
    check(["--system-prompt", flag, "--", flag], false);
  }
});

test("every unconditional built-in value role consumes flag-like values and separators", () => {
  for (const option of valueOptions) {
    check([option], false);
    check([option, ""], false);
    for (const flag of flags) {
      check([option, flag], false);
      check(["prompt", option, flag], false);
      check([option, flag, flag], true);
      check([option, flag, "--", flag], false);
      check([option, "--", flag], true);
      check([option, "--", "--", flag], false);
      check([option, "--system-prompt", flag], true);
      check([option, "--system-prompt", "--system-prompt", flag], false);
      check([option, "value", "--system-prompt", flag], false);
    }
  }
});

test("conditional and optional values cannot swallow no-skills or the separator", () => {
  for (const option of [
    "--mode",
    "--use-theme",
    "--tui-mode",
    "--print",
    "-p",
    "--list-models",
    "--unknown-extension-flag",
  ]) {
    for (const flag of flags) {
      check([option, flag], true);
      check([option, "--", flag], false);
      check([option, "value", flag], true);
      check([option, "@file", flag], true);
      check([option, "---prompt", flag], true);
      check([option, "--system-prompt", flag], false);
      check([option, "--system-prompt", "--", flag], true);
      check([option, "--system-prompt", "--", "--", flag], false);
    }
  }
  check(["--unknown-extension-flag=--no-skills"], false);
  check(["--system-prompt=--no-skills"], false);
  check(["--unknown-extension-flag=value", "--no-skills"], true);
});

test("extension screening preserves rejected spellings only in actual option roles", () => {
  checkExtensions([], false);
  for (const spelling of extensionSpellings) {
    const loadsExtension = extensionOptions.includes(spelling);
    checkExtensions([spelling, "path"], true, loadsExtension);
    checkExtensions([spelling], true);
    checkExtensions(["prompt", spelling, "path"], true, loadsExtension);
    checkExtensions(["--no-skills", spelling, "path"], true, loadsExtension);
    checkExtensions(["--", spelling, "path"], false);
    checkExtensions(["--system-prompt", "--", spelling, "path"], true, loadsExtension);
    checkExtensions(["--system-prompt", "--", "--", spelling, "path"], false);
    checkExtensions([`literal ${spelling}`], false);
    checkExtensions([`@${spelling}`], false);
    for (const option of valueOptions.filter((value) => !extensionOptions.includes(value))) {
      checkExtensions([option, spelling], false);
      checkExtensions([option, spelling, "--", "-e", "path"], false);
      checkExtensions([option, spelling, "-e", "path"], true, true);
    }
  }
});

test("conditional and optional options cannot swallow extension rejection spellings", () => {
  for (const option of [
    "--mode",
    "--use-theme",
    "--tui-mode",
    "--print",
    "-p",
    "--list-models",
    "--unknown-extension-flag",
  ]) {
    for (const spelling of extensionSpellings) {
      const loadsExtension = extensionOptions.includes(spelling);
      checkExtensions([option, spelling, "path"], true, loadsExtension);
      checkExtensions([option, "--system-prompt", spelling], false);
      checkExtensions([option, "--", spelling, "path"], false);
    }
  }
  checkExtensions(["--unknown-extension-flag=--extension=path"], false);
  checkExtensions(["--system-prompt=-e"], false);
});

test("non-value built-in options leave following no-skills flags and value roles intact", () => {
  for (const option of [
    "--help",
    "-h",
    "--version",
    "-v",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--no-session",
    "--no-tools",
    "-nt",
    "--no-builtin-tools",
    "-nbt",
    "--no-extensions",
    "-ne",
    "--no-mcp",
    "--no-prompt-templates",
    "-np",
    "--no-themes",
    "--no-context-files",
    "-nc",
    "--verbose",
    "--approve",
    "-a",
    "--no-approve",
    "-na",
    "--offline",
  ]) {
    for (const flag of flags) {
      check([option, flag], true);
      check([option, "--", flag], false);
      check([option, "--system-prompt", flag], false);
    }
  }
});
