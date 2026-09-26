import type { ExtensionAPI as BootstrapExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bundled with authority-guard.ts into a self-contained, persistent extension.
// Never symlink this bootstrap into the store: it must survive rollback + GC.
export async function loadPermissionAuthority(pi: BootstrapExtensionAPI): Promise<void> {
  let loaded = false;
  pi.on("tool_call", () => loaded ? undefined : {
    block: true,
    reason: "Permission bootstrap could not load its authority. Repair the Pi permission installation and start a new session; no tools were authorized.",
  });
  try {
    const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const selector = join(agentDir, "managed-permissions.json");
    let managed = true;
    try { lstatSync(selector); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      managed = false;
    }
    let entryPoint: string;
    if (managed) {
      // A dangling link, invalid selector or missing store closure is an error,
      // not permission to silently downgrade to an unpatched authority.
      const selection = JSON.parse(readFileSync(selector, "utf8"));
      if (selection?.version !== 1 || typeof selection.entryPoint !== "string" ||
          !isAbsolute(selection.entryPoint) || !selection.entryPoint.startsWith("/nix/store/") ||
          !selection.entryPoint.endsWith("/index.ts")) throw new Error("Invalid permission selector");
      entryPoint = selection.entryPoint;
    } else {
      // Older HM generations remove the selector, but do not own this copied
      // extension or Pi's npm directory. The pinned public package remains.
      const publicPackage = join(agentDir, "npm/node_modules/@gotgenes/pi-permission-system");
      if (JSON.parse(readFileSync(join(publicPackage, "package.json"), "utf8")).version !== "32.0.3") {
        throw new Error("Unexpected fallback permission version");
      }
      entryPoint = join(publicPackage, "src/index.ts");
    }
    const authority = await import(pathToFileURL(entryPoint).href);
    await authority.default(pi);
    loaded = true;
  } catch {
    // Throwing out of the factory would make the SDK discard its handlers.
    // Retain both the load-failure gate and the single-authority guard instead.
  }
}
