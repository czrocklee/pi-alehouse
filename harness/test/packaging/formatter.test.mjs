import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import prettier from "prettier";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ignorePath = [join(root, ".gitignore"), join(root, ".prettierignore")];
const plannedConfig = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  endOfLine: "lf",
  proseWrap: "preserve",
  embeddedLanguageFormatting: "off",
};

async function resolvedOptions(filepath) {
  const config = await prettier.resolveConfig(join(root, "composition.ts"));
  assert.deepEqual(config, plannedConfig);
  return { ...config, filepath };
}

test("format scripts are explicit, Prettier is a pinned dev dependency, and check does not write", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.format, "prettier --write .");
  assert.equal(pkg.scripts["format:check"], "prettier --check .");
  assert.equal(
    pkg.scripts.check,
    "npm run lint && npm run typecheck && npm test && npm run test:policy",
  );
  assert.doesNotMatch(pkg.scripts.check, /prettier|format/);
  assert.doesNotMatch(pkg.scripts["format:check"], /--write/);
  assert.equal(pkg.devDependencies.prettier, "3.9.10");
  assert.equal(pkg.dependencies.prettier, undefined);
  assert.equal(prettier.version, "3.9.10");
});

test("resolved config formats JS, TS, and JSON in memory and is idempotent", async () => {
  const samples = {
    "sample.js": "const value={alpha:1,beta:2}\n",
    "sample.ts": "export const value={\n\talpha:'one',\n\tbeta:'two'\n}\n",
    "sample.json": '{"name":"pi","ok":true}\n',
  };
  for (const [filepath, source] of Object.entries(samples)) {
    const options = await resolvedOptions(filepath);
    const formatted = await prettier.format(source, options);
    assert.notEqual(formatted, source, filepath);
    assert.equal(formatted.includes("\t"), false, filepath);
    assert.equal(await prettier.check(source, options), false, filepath);
    assert.equal(await prettier.check(formatted, options), true, filepath);
    assert.equal(await prettier.format(formatted, options), formatted, filepath);
  }
  const typescript = await prettier.format(
    samples["sample.ts"],
    await resolvedOptions("sample.ts"),
  );
  assert.match(typescript, /"one"/);
  assert.match(typescript, /"two",/);
  assert.match(typescript, /};/);
});

test("embedded templates and markdown stay literal under the resolved config", async () => {
  const source = "export const style=css`\n.a{color:red}\n`\n";
  const options = await resolvedOptions("embedded.ts");
  const formatted = await prettier.format(source, options);
  assert.match(formatted, /\.a\{color:red\}/);
  assert.doesNotMatch(formatted, /color: red/);
  assert.equal(await prettier.check(source, options), false);
  assert.equal(await prettier.format(formatted, options), formatted);

  const paragraph =
    "A deliberately long paragraph that exceeds one hundred characters so prose wrapping would reflow it if proseWrap were not preserve.";
  const markdown = `${paragraph}\n\n\`\`\`js\nconst embedded={a:1}\n\`\`\`\n`;
  const markdownOptions = await resolvedOptions("note.md");
  const markdownFormatted = await prettier.format(markdown, markdownOptions);
  assert.equal(markdownFormatted, markdown);
  assert.equal(await prettier.check(markdown, markdownOptions), true);
  const rewritten = await prettier.format(markdown, {
    ...markdownOptions,
    proseWrap: "always",
    embeddedLanguageFormatting: "auto",
  });
  assert.notEqual(rewritten, markdown);
});

test("ignore files exclude generated, private, and package paths but not source", async () => {
  for (const relative of [
    "node_modules/prettier/package.json",
    "runtime/agents/editor.md",
    ".runtime-build-fixture/out.js",
    "harness/dist/extension.js",
    "harness/.evidence/session.json",
    "artifacts/report.json",
    "coverage/lcov.info",
    ".cache/prettier.json",
    ".pi/agent/settings.json",
    ".claude/settings.json",
    ".mypy_cache/missing.py",
    ".ruff_cache/missing",
    "package-lock.json",
    "flake.lock",
    "nix/package.nix",
    "flake.nix",
    "resources/agent.md",
    "harness/docs/assets/README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "icon.svg",
    "package.tgz",
    "debug.log",
    "session.jsonl",
    ".env",
    ".env.local",
    "auth.json",
    "web-search.json",
  ]) {
    const info = await prettier.getFileInfo(join(root, relative), { ignorePath });
    assert.equal(info.ignored, true, relative);
    assert.equal(info.inferredParser, null, relative);
  }

  for (const [relative, parser] of [
    ["composition.ts", "typescript"],
    ["bin/pi-alehouse.mjs", "babel"],
    ["harness/src/extension.ts", "typescript"],
    ["lib/usage-attribution.mjs", "babel"],
    ["harness/docs/development.md", "markdown"],
    ["package.json", "json-stringify"],
    ["harness/release-policy.json", "json"],
  ]) {
    const file = join(root, relative);
    assert.equal(existsSync(file), true, relative);
    const info = await prettier.getFileInfo(file, { ignorePath });
    assert.equal(info.ignored, false, relative);
    assert.equal(info.inferredParser, parser, relative);
  }
});
