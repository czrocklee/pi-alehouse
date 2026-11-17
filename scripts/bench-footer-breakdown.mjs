// Offline source benchmark: node scripts/bench-footer-breakdown.mjs [checkout]
// The checkout needs source and the pinned node_modules, not generated files.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const args = process.argv.slice(2);
const usage = "Usage: node scripts/bench-footer-breakdown.mjs [checkout]";
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
if (args.length > 1 || args[0]?.startsWith("-")) {
  console.error(usage);
  process.exit(2);
}
const root = resolve(args[0] ?? fileURLToPath(new URL("..", import.meta.url)));
const layoutPath = resolve(root, "src/extensions/lib/footer-layout.ts");
const tuiVersion = createRequire(layoutPath)("@earendil-works/pi-tui/package.json").version;
globalThis.fetch = () => {
  throw new Error("The usage panel benchmark must not make network requests");
};
const jiti = createJiti(import.meta.url, { fsCache: false });
const { createFooterPanels } = await jiti.import(
  resolve(root, "src/extensions/lib/footer-panels.ts"),
);
const { breakdownFrame, breakdownTable, breakdownWidth, breakdownChromeRows } =
  await jiti.import(layoutPath);
const { POPOVER_DOCK_ROWS } = await jiti.import(resolve(root, "src/shared/popover-stack.mjs"));
const { setBorderLabelsEnabled } = await jiti.import(
  resolve(root, "src/shared/popover-chrome.mjs"),
);

const theme = {
  fg: (color, text) =>
    `\x1b[${color === "accent" ? 36 : color === "warning" ? 33 : 90}m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};
const cases = [
  { name: "wide-stable", modelRows: 6, columns: 120, rows: 36, labels: true, updates: false },
  { name: "tight-stable", modelRows: 18, columns: 45, rows: 24, labels: false, updates: false },
  { name: "tight-updating", modelRows: 18, columns: 45, rows: 24, labels: false, updates: true },
];
const warmup = 1_500;
const frames = 2_000;
const samples = 7;
const on = () => () => {};
function measure({ name, modelRows, columns, rows, labels, updates }) {
  const spendVariants = Array.from({ length: updates ? 16 : 1 }, (_v, variant) =>
    Array.from({ length: modelRows }, (_row, index) => ({
      key: `fixture/${index % 2 === 0 ? "model" : "模型"}-${index}-long-identifier`,
      input: 12753 * (index + 1) + 100 * variant,
      output: 723 * (index + 1) + variant,
      cacheRead: 48932 * (index + 1),
      cacheWrite: 200 * (index + 1),
      cost: (modelRows - index) * 0.124 + variant * 0.003,
    })),
  );
  let spend = spendVariants[0];
  let overlay;
  const tui = {
    mode: "fullscreen",
    terminal: { rows, columns },
    requestRender() {},
    showOverlay(component, options) {
      overlay = { component, options };
      return { hide() {}, isFocused: () => false };
    },
  };
  setBorderLabelsEnabled(labels);
  const panels = createFooterPanels({
    pi: { events: { on }, on },
    ctx: { hasUI: true, ui: {} },
    tui,
    theme,
    spend: () => spend,
    currentFooter: () => true,
  });
  try {
    panels.toggleBreakdown();
    const { component, options } = overlay;
    const paint = (variant) => {
      spend = variant;
      // Same visibility -> width -> render -> width sequence as Pi's compositor.
      assert(options.visible(), `${name}: panel must be visible`);
      const lines = component.render(Math.min(columns, options.width));
      void options.width;
      return lines;
    };
    // Check every variant against a fresh SDK fit, not just the dimensions of
    // its heading. Keep the comparison, serialization and hash out of timings.
    const snapshots = spendVariants.map((variant, index) => {
      const table = breakdownTable(variant, rows - POPOVER_DOCK_ROWS - breakdownChromeRows());
      const expected = breakdownFrame(table, theme, Math.min(columns, breakdownWidth(table)));
      const actual = paint(variant);
      assert.deepEqual(actual, expected, `${name}: rendered rows differ for variant ${index}`);
      return JSON.stringify(actual);
    });
    assert.equal(new Set(snapshots).size, spendVariants.length, `${name}: indistinct fixtures`);
    const frameSha256 = createHash("sha256").update(snapshots.join("\n")).digest("hex");
    const run = (count) => {
      for (let index = 0; index < count; index++)
        paint(spendVariants[index % spendVariants.length]);
    };
    run(warmup);
    const ms = [];
    for (let sample = 0; sample < samples; sample++) {
      const start = performance.now();
      run(frames);
      ms.push(performance.now() - start);
    }
    return { name, ms, medianMs: [...ms].sort((a, b) => a - b)[samples >> 1], frameSha256 };
  } finally {
    panels.dispose(() => {});
    setBorderLabelsEnabled(true);
  }
}

console.log(
  JSON.stringify(
    {
      scope: "offline synthetic fullscreen Usage panel; not end-to-end latency",
      node: process.version,
      piTui: tuiVersion,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      warmup,
      frames,
      samples,
      cases: cases.map(measure),
    },
    null,
    2,
  ),
);
