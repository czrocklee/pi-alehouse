// Copied read-only outside the checkout and loaded by Pi's real extension loader.
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export default async function (pi) {
  let permissionBareImport = false;
  try {
    const service = await import("@gotgenes/pi-permission-system");
    permissionBareImport = typeof service.getPermissionsService === "function";
  } catch { /* Record rather than assume cross-package bare import resolution. */ }
  const service = await import(pathToFileURL(join(dirname(process.env.P0_PERMISSION_ROOT), "index.ts")).href);
  pi.events.emit("pi-agent-harness:p0:store-probe", { createAgentSession, SessionManager, Text,
    permissionNode: service.getPermissionsService(process.env.P0_PROBE_PARENT_SESSION),
  });
  writeFileSync(join(process.env.P0_REPORT_DIR, "store-probe.json"), JSON.stringify({
    hostImports: typeof createAgentSession === "function" && typeof SessionManager === "function" && typeof Text === "function",
    permissionBareImport,
    permissionFromExplicitRoot: typeof service.getPermissionsService === "function",
    source: import.meta.url,
  }, null, 2), { mode: 0o600 });
}
