import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Context native compositor preserves focus, yield lifecycle, route provenance and atomic totals", () => {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../../scripts/checks/check-pi-context-native.mjs", import.meta.url))],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 60000,
    },
  );
});
