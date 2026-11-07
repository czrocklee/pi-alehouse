#!/usr/bin/env node
// Local UI regressions against the installed Pi runtime; no model or network calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createUiFixture } from "./ui-fixture.mjs";
import { registerTitleTests } from "./ui-title.mjs";
import { createFooterTests } from "./ui-footer.mjs";
import { registerApprovalTests } from "./ui-approval.mjs";
import { registerStatsTests } from "./ui-stats.mjs";

const [piExecutable, footerEntry] = process.argv.slice(2);
assert(piExecutable, "Usage: node script/check-pi-ui.mjs PI_EXECUTABLE [BUILT_FOOTER]");
const root = resolve(import.meta.dirname, "../..");
const require = createRequire(realpathSync(piExecutable));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: { "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui") },
});
const extensions = join(root, "src/extensions");
const { default: titleExtension } = await jiti.import(join(extensions, "terminal-title-status.ts"));
const { default: footerExtension } = await jiti.import(
  footerEntry ?? join(extensions, "status-footer.ts"),
);
const {
  default: approvalExtension,
  ApprovalPopover,
  APPROVAL_ENTRY,
  approvalChoices,
  approvalStatus,
  currentChoice,
} = await jiti.import(join(extensions, "approval-mode.ts"));
const { SESSION_YOLO_KEY } = await jiti.import(join(extensions, "lib/approval-protocol.ts"));
const { managedSessionYolo } = await jiti.import(
  join(root, "src/authority/managed-session-yolo.ts"),
);
const { default: statsExtension, healthStatus } = await jiti.import(join(extensions, "stats.ts"));
const { SessionStats } = await jiti.import(join(extensions, "lib/session-stats.ts"));
const { WorkerStats } = await jiti.import(join(extensions, "lib/worker-stats.ts"));
// Drive the independently loaded footer through the orchestration bundle's
// exported shared protocol. This checks their interaction, not merely equality
// of source text.
const { HIDE_TRANSIENT_OVERLAYS_EVENT } = await jiti.import(
  join(root, "src/orchestration/ui/overlay-request.ts"),
);
const { FOOTER_INDICATOR_CLICK_EVENT, WORKER_PRESET_INDICATOR, HEALTH_INDICATOR } = await import(
  pathToFileURL(join(root, "src/shared/overlay-protocol.mjs")).href
);
// The orchestration bundle joins the same column; so does this script.
const { joinPopoverStack, stackedOverlayOptions } = await import(
  pathToFileURL(join(root, "src/shared/popover-stack.mjs")).href
);
const { POPOVER } = await jiti.import(join(root, "src/orchestration/ui/popover.ts"));
const { PresetPicker } = await jiti.import(join(root, "src/orchestration/ui/preset-picker.ts"));
const { TuiAltScreen, visibleWidth } = await import(require.resolve("@earendil-works/pi-tui"));
// Pi's package export is import-only; resolve its SDK beside the selected CLI,
// including the installed bundled CLI layout, rather than using dev dependencies.
let sdkRoot = dirname(realpathSync(piExecutable));
while (!existsSync(join(sdkRoot, "package.json"))) {
  assert.notEqual(sdkRoot, dirname(sdkRoot), "Pi package not found");
  sdkRoot = dirname(sdkRoot);
}
assert.equal(
  JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")).name,
  "@earendil-works/pi-coding-agent",
);
const { SessionManager, AgentSession, createEventBus, ExtensionRunner } = await import(
  pathToFileURL(join(sdkRoot, "dist/index.js"))
);
const { STATS_WORKER_ATTACH } = await import(
  pathToFileURL(join(root, "src/shared/stats-protocol.mjs"))
);

const fixture = createUiFixture(createEventBus, ExtensionRunner);
registerTitleTests(titleExtension, fixture, visibleWidth);
const footerTests = createFooterTests(
  footerExtension,
  fixture,
  TuiAltScreen,
  visibleWidth,
  POPOVER,
  PresetPicker,
  joinPopoverStack,
  stackedOverlayOptions,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  WORKER_PRESET_INDICATOR,
  ApprovalPopover,
  approvalChoices,
  SessionManager,
  AgentSession,
  approvalStatus,
  healthStatus,
  HEALTH_INDICATOR,
);
footerTests.registerMain();
registerApprovalTests(
  approvalExtension,
  ApprovalPopover,
  APPROVAL_ENTRY,
  approvalChoices,
  approvalStatus,
  currentChoice,
  SESSION_YOLO_KEY,
  managedSessionYolo,
  fixture,
  TuiAltScreen,
  joinPopoverStack,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  footerTests.FOOTER_HEIGHT,
  footerTests.nextTick,
);
footerTests.registerCorner();
registerStatsTests(
  statsExtension,
  healthStatus,
  SessionStats,
  WorkerStats,
  fixture,
  footerExtension,
  TuiAltScreen,
  STATS_WORKER_ATTACH,
  HEALTH_INDICATOR,
  WORKER_PRESET_INDICATOR,
  HIDE_TRANSIENT_OVERLAYS_EVENT,
  FOOTER_INDICATOR_CLICK_EVENT,
  root,
  extensions,
);
