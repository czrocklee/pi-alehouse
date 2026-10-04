// Documentation-only controlled render. No terminal, registry, provider or user
// configuration is opened. The SVG caption must identify these example models.
import { PresetPicker } from "../../dist/ui/preset-picker.js";

export const effortIllustrationWidth = 80;
export function renderEffortIllustration(theme) {
  const slots = ["d1", "d2", "d3", "d4", "d5"];
  const defaults = { d1: "off", d2: "low", d3: "medium", d4: "medium", d5: "high" };
  const preset = {
    name: "example-team", version: "illustration-v3", digest: "0".repeat(64),
    models: Object.fromEntries(slots.map((slot) => [slot, `example/model-${slot}`])),
    effort_defaults: defaults, effort_overrides: { d3: "high" },
    effort: { ...defaults, d3: "high" },
  };
  const picker = new PresetPicker({
    tui: { terminal: { rows: 30, columns: effortIllustrationWidth }, requestRender() {} },
    theme, keybindings: { matches: () => false }, presets: [preset],
    activeName: preset.name, pointer: true, startInEffort: true,
    efforts: () => ({ levels: ["off", "low", "medium", "high"], inherited: "medium" }),
    setEffort: () => preset, done() {},
  });
  return picker.render(effortIllustrationWidth);
}
