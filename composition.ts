import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// This entry deliberately has no runtime imports before the latch. Pi discards
// all factory registrations if its factory throws, so dependency loading and
// invocation stay inside the catch boundary. Syntax errors in THIS entry cannot
// be guarded by its own code; the CLI checks availability, not arbitrary damage.
export default async function alehouse(pi: ExtensionAPI) {
  let failed = "Alehouse initialization has not completed";
  let failureLatched = false;
  let assembled = false;
  let started = false;
  const sessionHarnessTools = new Set<string>();
  let sessionId: string | undefined;
  let authority: unknown;
  const currentAuthority = () => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("@gotgenes/pi-permission-system:session-services")];
    return sessionId && registry instanceof Map ? registry.get(sessionId) : undefined;
  };
  const reason = () => failed || (!assembled || !started ? "Alehouse session is not ready" :
    !authority || currentAuthority() !== authority ? "Alehouse permission authority is unavailable or changed" : "");
  const fail = (error: unknown) => {
    failureLatched = true;
    failed = `Alehouse failed closed: ${String(error).slice(0, 2048)}. Restart Pi after fixing the installation; live reload is unsupported.`;
    try { console.error(failed); } catch { /* reporting must not discard the latch */ }
  };
  // First, separate registrations; never flatten/reorder lifecycle dispatch.
  pi.on("tool_call", () => { const error = reason(); if (error) return { block: true, reason: error }; });
  pi.on("user_bash", () => { const error = reason(); if (error) throw new Error(error); });
  pi.on("session_start", (_event, ctx) => {
    started = false;
    sessionHarnessTools.clear();
    authority = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    if (failed) { try { ctx.ui.notify(failed, "error"); } catch { /* stderr already reported */ } }
  });
  pi.on("session_shutdown", () => { started = false; });

  // ExtensionAPI stores keyed registrations in maps. Calling child factories
  // with one naked API would silently overwrite a prior factory's registration.
  const owners = new Map<string, string>();
  const keyed = new Set(["registerTool", "registerCommand", "registerShortcut", "registerFlag", "registerMessageRenderer", "registerEntryRenderer", "registerProvider"]);
  function scoped(owner: string): ExtensionAPI {
    return new Proxy(pi, {
      get(target, property) {
        const original = Reflect.get(target, property);
        if (typeof original !== "function") return original;
        if (keyed.has(String(property))) return (...args: unknown[]) => {
          const first = args[0] as string | { name?: string; id?: string };
          const name = typeof first === "string" ? first : first?.name ?? first?.id;
          const key = `${String(property)}:${name}`;
          const previous = owners.get(key);
          if (previous !== undefined && previous !== owner) {
            const error = new Error(`Registration collision ${key}: ${previous} / ${owner}`);
            fail(error); throw error;
          }
          const result = original.apply(target, args);
          owners.set(key, owner);
          if (owner === "harness" && property === "registerTool" && typeof name === "string") sessionHarnessTools.add(name);
          return result;
        };
        if (property === "on") return (event: string, handler: (...args: unknown[]) => unknown) => {
          if (event !== "session_start") return original.call(target, event, handler);
          return original.call(target, event, async (...args: unknown[]) => {
            try { return await handler(...args); }
            catch (error) { fail(`${owner} session_start: ${String(error)}`); throw error; }
          });
        };
        return original.bind(target);
      },
    });
  }

  try {
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const support = await import("./bin/runtime-support.mjs");
    const paths = support.preflight();
    const env = support.runtimeEnvironment(paths);
    for (const key of ["PI_CODING_AGENT_DIR", "PI_HARNESS_PERMISSION_ROOT", "PI_HARNESS_POLICY_ROOT", "PI_HARNESS_FLOCK", "PI_AUTO_APPROVAL_MODE", "PI_JEV_APPROVAL_MODE"]) process.env[key] = env[key];
    if (env.PI_JEV_API_KEY_FILE) process.env.PI_JEV_API_KEY_FILE = env.PI_JEV_API_KEY_FILE;
    // Establish deny-only resource/credential floors before Jev captures and
    // removes its key-file environment variable. Importing is not invocation:
    // the managed authority factory still runs in its original fourth slot.
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    const permissionEntry = await import(pathToFileURL(join(paths.permissionRoot, "index.ts")).href);
    permissionEntry.initializeManagedResourceProtection(support.protectionResources(paths, process.env, support.packageRoot, getPackageDir()));
    const entries = [
      ["harness", join(support.packageRoot, "harness/src/extension.ts")],
      ["ui-prompt-queue", join(paths.runtime, "policy/ui-prompt-queue.ts")],
      ["jev", join(paths.policyRoot, "jev-auto-approval.ts")],
      ["managed-permissions", join(paths.permissionRoot, "index.ts")],
      ["static-safety-guard", join(paths.policyRoot, "static-safety-guard.ts")],
      ["policy-grep", join(paths.policyRoot, "policy-grep.ts")],
      ["footer", join(paths.runtime, "policy/status-footer.ts")],
      ["approval-mode", join(paths.runtime, "policy/approval-mode.ts")],
      ["stats", join(paths.runtime, "policy/stats.ts")],
      ["terminal-title", join(paths.runtime, "policy/terminal-title-status.ts")],
      ["web-access", paths.web],
    ];
    for (const [name, path] of entries) {
      // Luna is an internal Jev helper dependency, NEVER an invoked factory.
      const extension = await import(pathToFileURL(path).href);
      if (typeof extension.default !== "function") throw new Error(`Invalid factory: ${name}`);
      await extension.default(scoped(name));
    }
    if (failureLatched) return; // A factory may have caught its own collision.
    const { managementToolNames } = await import("./harness/src/tools/tool-names.ts");
    assembled = true;
    failed = "";
    pi.on("session_start", () => {
      if (failed) return;
      authority = currentAuthority();
      if (!authority) { fail("Permission authority did not become ready"); return; }
      // Off still registers every management tool; invalid presets return
      // before doing so. Require fresh successful registrations for this start,
      // not stale tool ownership from a previous session. getAllTools() is also
      // refreshed only after session_start dispatch completes.
      if (managementToolNames.some((name) => !sessionHarnessTools.has(name))) {
        fail("Harness initialization did not complete; inspect the reported preset error and harness-presets.json");
        return;
      }
      started = true;
    });
  } catch (error) { fail(error); }
}
