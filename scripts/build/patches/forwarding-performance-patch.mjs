// Optional notification hints; never replace polling or forwarding authority.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../generate-workers.mjs";

export function applyForwardingPerformancePatch(root, patch) {
  copyFileSync(
    join(packageRoot, "src/authority/managed-forwarding-watch.ts"),
    join(root, "src/authority/managed-forwarding-watch.ts"),
  );
  patch("src/index.ts", [
    [
      "    new ForwardingManager({\n      forwarder: requestServer,",
      "    new ForwardingManager({\n      forwardingDir: paths.forwardingDir,\n      forwarder: requestServer,",
    ],
  ]);
  patch("src/authority/forwarding-manager.ts", [
    [
      'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";',
      'import type { ExtensionContext } from "@earendil-works/pi-coding-agent";\nimport { watchPermissionDirectory, type PermissionDirectoryWatch } from "./managed-forwarding-watch";',
    ],
    [
      "  normalizePermissionForwardingSessionId,",
      "  createPermissionForwardingLocation,\n  normalizePermissionForwardingSessionId,",
    ],
    [
      "export interface ForwardingManagerDeps {",
      "export interface ForwardingManagerDeps {\n  /** Optional notification root; mocks/older collaborators retain polling. */\n  forwardingDir?: string;",
    ],
    [
      "  private processing = false;",
      "  private processing: object | null = null;\n  private watcher: PermissionDirectoryWatch | undefined;\n  private watchedSessionId: string | null = null;",
    ],
    [
      "    this.announceServing(getSessionId(ctx));",
      "    this.announceServing(getSessionId(ctx));\n    this.refreshWatch();",
    ],
    [
      `      this.refreshServing();
      if (!this.context || this.processing) {
        return;
      }
      this.processing = true;
      void this.deps.forwarder.processInbox(this.context).finally(() => {
        this.processing = false;
      });`,
      `      this.refreshServing();
      this.refreshWatch();
      this.processPending();`,
    ],
    [
      `    this.withdrawServing();
    this.context = null;
    this.processing = false;`,
      `    this.withdrawServing();
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedSessionId = null;
    this.context = null;
    this.processing = null;`,
    ],
    [
      "  // ── Private methods ────────────────────────────────────────────────",
      `  // ── Private methods ────────────────────────────────────────────────

  private processPending(): void {
    if (!this.context || this.processing) return;
    const pending = {};
    this.processing = pending;
    void this.deps.forwarder.processInbox(this.context).finally(() => {
      // An old exchange finishing after stop/start cannot unlock its successor.
      if (this.processing === pending) this.processing = null;
    });
  }

  private refreshWatch(): void {
    const root = this.deps.forwardingDir;
    const sessionId = this.context ? normalizePermissionForwardingSessionId(getSessionId(this.context)) : null;
    if (this.watchedSessionId === sessionId && this.watcher) {
      // Retain inactive observers: their bounded retry deadline must survive
      // both the 250ms poll and repeated start/tool-call lifecycle hooks.
      this.watcher.refresh();
      return;
    }
    this.watcher?.close();
    this.watcher = undefined;
    this.watchedSessionId = sessionId;
    if (!root || !sessionId) return;
    const location = createPermissionForwardingLocation(root, sessionId);
    this.watcher = watchPermissionDirectory(location.requestsDir, () => {
      // A queued event from a switched session is not a new serving authority.
      if (this.context && getSessionId(this.context) === sessionId) this.processPending();
    }, root);
  }`,
    ],
  ]);
  patch("src/authority/approval-escalator.ts", [
    [
      'import { existsSync } from "node:fs";',
      'import { existsSync } from "node:fs";\nimport { permissionResponseWake } from "./managed-forwarding-watch";',
    ],
    [
      "  safeDeleteFile,\n  sleep,\n  writeJsonFileAtomic,",
      "  safeDeleteFile,\n  writeJsonFileAtomic,",
    ],
    [
      "    while (Date.now() < deadline) {",
      "    const wake = permissionResponseWake(location.responsesDir);\n    try {\n    while (Date.now() < deadline) {",
    ],
    [
      "      await sleep(PERMISSION_FORWARDING_POLL_INTERVAL_MS);",
      "      await wake.wait(PERMISSION_FORWARDING_POLL_INTERVAL_MS);",
    ],
    [
      [
        "    this.discardRequest(location, requestPath);",
        "    return abandon(",
        "      `Session '${target.sessionId}' did not answer within ${timeoutMs / 1000}s`,",
        "    );",
        "  }",
      ].join("\n"),
      [
        "    this.discardRequest(location, requestPath);",
        "    return abandon(",
        "      `Session '${target.sessionId}' did not answer within ${timeoutMs / 1000}s`,",
        "    );",
        "    } finally { wake.close(); }",
        "  }",
      ].join("\n"),
    ],
  ]);
}
