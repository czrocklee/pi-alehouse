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
  const managementTools = new Set<string>();
  // Whatever the parent's pi-web-access registered, under its configured names:
  // orchestration hides these while autonomous delegation routes web work to scouts.
  const parentWebTools = new Set<string>();
  let sessionId: string | undefined;
  let authority: unknown;
  const currentAuthority = () => {
    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@gotgenes/pi-permission-system:session-services")
    ];
    return sessionId && registry instanceof Map ? registry.get(sessionId) : undefined;
  };
  const reason = () =>
    failed ||
    (!assembled || !started
      ? "Alehouse session is not ready"
      : !authority || currentAuthority() !== authority
        ? "Alehouse permission authority is unavailable or changed"
        : "");
  const fail = (error: unknown) => {
    failureLatched = true;
    failed = `Alehouse failed closed: ${String(error).slice(0, 2048)}. Restart Pi after fixing the installation; live reload is unsupported.`;
    try {
      console.error(failed);
    } catch {
      /* reporting must not discard the latch */
    }
  };
  // First, separate registrations; never flatten/reorder lifecycle dispatch.
  pi.on("tool_call", () => {
    const error = reason();
    if (error) return { block: true, reason: error };
  });
  pi.on("user_bash", () => {
    const error = reason();
    if (error) throw new Error(error);
  });
  pi.on("session_start", (_event, ctx) => {
    started = false;
    managementTools.clear();
    authority = undefined;
    sessionId = ctx.sessionManager.getSessionId();
    if (failed) {
      try {
        ctx.ui.notify(failed, "error");
      } catch {
        /* stderr already reported */
      }
    }
  });
  pi.on("session_shutdown", () => {
    started = false;
  });

  // ExtensionAPI stores keyed registrations in maps. Calling child factories
  // with one naked API would silently overwrite a prior factory's registration.
  const owners = new Map<string, string>();
  const keyed = new Set([
    "registerTool",
    "registerCommand",
    "registerShortcut",
    "registerFlag",
    "registerMessageRenderer",
    "registerEntryRenderer",
    "registerProvider",
  ]);
  function scoped(owner: string): ExtensionAPI {
    return new Proxy(pi, {
      get(target, property) {
        const original = Reflect.get(target, property);
        if (typeof original !== "function") return original;
        if (keyed.has(String(property)))
          return (...args: unknown[]) => {
            const first = args[0] as string | { name?: string; id?: string };
            const name = typeof first === "string" ? first : (first?.name ?? first?.id);
            const key = `${String(property)}:${name}`;
            const previous = owners.get(key);
            if (previous !== undefined && previous !== owner) {
              const error = new Error(`Registration collision ${key}: ${previous} / ${owner}`);
              fail(error);
              throw error;
            }
            const result = original.apply(target, args);
            owners.set(key, owner);
            if (
              owner === "orchestration" &&
              property === "registerTool" &&
              typeof name === "string"
            )
              managementTools.add(name);
            if (owner === "web-access" && property === "registerTool" && typeof name === "string")
              parentWebTools.add(name);
            return result;
          };
        if (property === "on")
          return (event: string, handler: (...args: unknown[]) => unknown) => {
            if (event !== "session_start") return original.call(target, event, handler);
            return original.call(target, event, async (...args: unknown[]) => {
              try {
                return await handler(...args);
              } catch (error) {
                fail(`${owner} session_start: ${String(error)}`);
                throw error;
              }
            });
          };
        return original.bind(target);
      },
    });
  }

  try {
    const { join } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const support = await import("../bin/runtime-support.mjs");
    const paths = support.preflight();
    const env = support.runtimeEnvironment(paths);
    for (const key of [
      "PI_CODING_AGENT_DIR",
      "PI_ALEHOUSE_PERMISSION_ROOT",
      "PI_ALEHOUSE_POLICY_ROOT",
      "PI_ALEHOUSE_FLOCK",
      "PI_ALEHOUSE_WEB_ENTRY",
      "PI_JEV_APPROVAL_MODE",
    ])
      process.env[key] = env[key];
    if (env.PI_JEV_API_KEY_FILE) process.env.PI_JEV_API_KEY_FILE = env.PI_JEV_API_KEY_FILE;
    // Establish deny-only resource/credential floors before Jev captures and
    // removes its key-file environment variable. Importing is not invocation:
    // the managed authority factory still runs in its original fourth slot.
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    const permissionEntry = await import(
      pathToFileURL(join(paths.permissionRoot, "index.ts")).href
    );
    permissionEntry.initializeManagedResourceProtection(
      support.protectionResources(paths, process.env, support.packageRoot, getPackageDir()),
    );
    const { loadParentWeb } = await import("./orchestration/runtime/parent-web.ts");
    const entries = [
      ["orchestration", join(support.packageRoot, "src/orchestration/extension.ts")],
      ["ui-prompt-queue", join(paths.runtime, "extensions/ui-prompt-queue.ts")],
      ["jev", join(paths.policyRoot, "jev-auto-approval.ts")],
      ["managed-permissions", join(paths.permissionRoot, "index.ts")],
      ["static-safety-guard", join(paths.policyRoot, "static-safety-guard.ts")],
      ["policy-grep", join(paths.policyRoot, "policy-grep.ts")],
      ["footer", join(paths.runtime, "extensions/status-footer.ts")],
      ["approval-mode", join(paths.runtime, "extensions/approval-mode.ts")],
      ["stats", join(paths.runtime, "extensions/stats.ts")],
      ["terminal-title", join(paths.runtime, "extensions/terminal-title-status.ts")],
      ["web-access", paths.web],
      ["clear", join(paths.runtime, "extensions/clear.ts")],
    ];
    for (const [name, path] of entries) {
      // Reuse the module already checked above; a second loader must not bind
      // an unbundled SDK graph. Factories and lifecycle registrations retain
      // their original order, including orchestration shutdown before authority.
      const extension =
        name === "managed-permissions"
          ? permissionEntry
          : name === "web-access"
            ? await loadParentWeb(path)
            : await import(pathToFileURL(path).href);
      if (typeof extension.default !== "function") throw new Error(`Invalid factory: ${name}`);
      // The orchestration factory runs before web-access registers, so it reads the
      // set when it needs it rather than copying it now.
      if (name === "orchestration")
        await extension.default(scoped(name), {
          permission: permissionEntry,
          parentWebTools: () => [...parentWebTools],
        });
      else await extension.default(scoped(name));
    }
    if (failureLatched) return; // A factory may have caught its own collision.
    const { managementToolNames } = await import("./orchestration/tools/tool-names.ts");
    assembled = true;
    failed = "";
    pi.on("session_start", () => {
      if (failed) return;
      authority = currentAuthority();
      if (!authority) {
        fail("Permission authority did not become ready");
        return;
      }
      // Off still registers every management tool; invalid presets return
      // before doing so. Require fresh successful registrations for this start,
      // not stale tool ownership from a previous session. getAllTools() is also
      // refreshed only after session_start dispatch completes.
      if (managementToolNames.some((name) => !managementTools.has(name))) {
        fail(
          "Alehouse initialization did not complete; inspect the reported startup error (alehouse-presets.json or a saved preset or delegation record)",
        );
        return;
      }
      started = true;
    });
  } catch (error) {
    fail(error);
  }
}
