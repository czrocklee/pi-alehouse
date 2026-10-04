import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderEffortIllustration } from "../harness/test/support/effort-illustration.mjs";

// Synthetic privacy canaries are used only in temporary test files, never in
// the README images. Images label their provenance: reviewed real captures
// (including historical UI) or controlled UI renders with example models.
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "alehouse-panel-test-"));
  try {
    mkdirSync(join(root, "scripts"));
    copyFileSync(new URL("../scripts/render-readme.mjs", import.meta.url), join(root, "scripts/render-readme.mjs"));
    symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir");
    const screen = join(root, "screen.ansi"), colors = join(root, "colors.txt");
    writeFileSync(colors, ["background #112233", "foreground #ddeeff", ...Array.from({ length: 256 }, (_, i) => `color${i} #445566`)].join("\n"));
    const execute = (text, extra = []) => {
      writeFileSync(screen, text, { mode: 0o600 });
      const result = spawnSync(process.execPath, [join(root, "scripts/render-readme.mjs"),
        "--screen", screen, "--colors", colors, "--title", "Capture check", "--output", "check.svg", ...extra], { encoding: "utf8" });
      const output = join(root, "harness/docs/assets/check.svg");
      const svg = existsSync(output) ? readFileSync(output, "utf8") : undefined;
      if (existsSync(output)) rmSync(output);
      return { ...result, svg };
    };
    run(execute);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function frame(lines, { prefix = "", width = 72 } = {}) {
  return ["PRIVATE_BACKGROUND_BEFORE", `${prefix}╭${"─".repeat(width)}╮`,
    ...lines.map((line) => {
      const plain = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      return `${prefix}│${line}${" ".repeat(width - plain.length)}│`;
    }), `${prefix}╰${"─".repeat(width)}╯`, "PRIVATE_BACKGROUND_AFTER"].join("\n");
}

test("effort illustration follows the current five-slot renderer and labels its controlled provenance", () => {
  const svg = readFileSync(new URL("../harness/docs/assets/effort-panel.svg", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const plain = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1]
    .replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .join("").replace(/\s+/g, " ");
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const lines = renderEffortIllustration(theme);
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith("├")) continue;
    const content = line.slice(1, -1).trim().replace(/\s+/g, " ");
    assert(plain.includes(content), `SVG differs from the current renderer: ${content}`);
  }
  const order = [...plain.matchAll(/‹(d[1-5]):/g)].map((match) => match[1]);
  assert.deepEqual(order, ["d5", "d4", "d3", "d2", "d1"]);
  assert.match(svg, /aria-label="Five-slot effort editor.*controlled UI render/);
  assert.match(plain, /Controlled UI render · example models/);
  assert.doesNotMatch(plain, /light:|standard:|strong:|d1–2|d4–5|Apply|Real terminal capture/);
  assert.match(readme, /Current UI renderer with example models, not a live-provider capture/);
  const provenance = readFileSync(new URL("../harness/docs/assets/README.md", import.meta.url), "utf8");
  assert.match(provenance, /effort-panel\.svg.*controlled UI render with example models/i);
  assert.doesNotMatch(provenance, /These images come from a real working terminal session|They are not mockups or synthetic workloads/);
  const historical = readFileSync(new URL("../harness/docs/assets/routing-panel.svg", import.meta.url), "utf8");
  assert.match(historical, /aria-label="Historical three-slot/);
  assert.match(historical, /Historical terminal capture/);
});

test("panel export excludes background and OSC payloads while retaining real text and colors", () => fixture((execute) => {
  const result = execute(frame(["\x1b[38:2::1:2:3mVisible <&>\x1b[0m",
    "\x1b]8;;file:///PRIVATE_LINK_TARGET\x1b\\Link label\x1b]8;;\x1b\\"], { prefix: "界 PRIVATE_SIDE " }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.svg, /Visible &lt;&amp;&gt;/);
  assert.match(result.svg, /#010203/);
  assert.match(result.svg, /Link label/);
  assert.doesNotMatch(result.svg, /PRIVATE_|file:\/\/|href=|<script|foreignObject/);
}));

test("panel redaction removes original field values and wrapped continuation before serialization", () => fixture((execute) => {
  const result = execute(frame(["  run       PRIVATE_RUN_IDENTIFIER", "            PRIVATE_RUN_CONTINUATION",
    "  routing   configured-route", "  cwd       /PRIVATE_HOME/PRIVATE_PROJECT", "  model     actual-visible-model"]),
  ["--redact-field", "run", "--redact-field", "cwd", "--caption", "Identifiers and path hidden"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.svg, /\[identifiers hidden\]/);
  assert.match(result.svg, /\[path hidden\]/);
  assert.match(result.svg, /actual-visible-model/);
  assert.doesNotMatch(result.svg, /PRIVATE_/);
}));

test("panel export refuses ambiguous frames, interrupted borders, and unfulfilled redactions", () => fixture((execute) => {
  const valid = frame(["Visible row"]);
  for (const [text, extra] of [
    [valid + "\n" + valid, []],
    [valid.replace("│Visible", " Visible"), []],
    [valid, ["--redact-field", "cwd", "--caption", "Path hidden"]],
    [valid, ["--redact-field", "cwd"]],
    [frame(["  cwd       first", "  cwd       second"]), ["--redact-field", "cwd", "--caption", "Path hidden"]],
  ]) {
    const result = execute(text, extra);
    assert.notEqual(result.status, 0);
    assert.equal(result.svg, undefined, "an unsafe export must not create an image");
  }
}));
