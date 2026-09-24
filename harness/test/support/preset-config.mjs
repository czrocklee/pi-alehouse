import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

// Deliberately synthetic model IDs and route names for routing/UI tests, NOT
// an operator catalogue. Never copy an installed/personal catalogue here.
const source = new URL("./presets.json", import.meta.url);
export const starterPath = fileURLToPath(source);

// Parse afresh so test mutations never contaminate another fixture; never
// consult the developer's ~/.pi/agent.
export const starterConfig = () => JSON.parse(readFileSync(source, "utf8"));
export const presetConfig = (presets = {}, rest = {}) => {
  const starter = starterConfig();
  return { ...starter, presets: { ...starter.presets, ...presets }, ...rest };
};
export const writePresetConfig = (path, config = starterConfig()) => writeFile(path, JSON.stringify(config));
