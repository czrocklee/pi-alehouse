// Apply only to the pinned dependency closure, never the mutable live install.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyManagedReadPatch } from "./managed-read-patch.mjs";
import {
  applyManagedGitPresentationPatch,
  applyManagedPromptLifecyclePatch,
  applyManagedHiddenToolsPatch,
} from "./managed-presentation-patch.mjs";
import {
  applyManagedAgentWriteFloorPatch,
  applyManagedSessionYoloPatch,
  applyManagedResourceFloorPatch,
} from "./managed-floor-patch.mjs";
import {
  applyManagedForwardingObservationPatch,
  applyManagedForwardedPrincipalPatch,
  applyManagedToolCallPrincipalPatch,
} from "./managed-principal-patch.mjs";
import { applyProfileDisplayPatch } from "./profile-display-patch.mjs";
import { applyNativeGitPatch } from "./native-git-patch.mjs";
import { applyRedirectArgvPatch } from "./redirect-argv-patch.mjs";
import { applyPermissionPerformancePatch } from "./performance-patch.mjs";

const root = process.argv[2];
assert(root, "Usage: node apply-patch.mjs PACKAGE_ROOT");
assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).version, "32.0.3");

// The split managed patches share this sequential, exactly-one-anchor guard.
function patch(file, edits) {
  let text = readFileSync(join(root, file), "utf8");
  for (const [before, after] of edits) {
    assert.equal(text.split(before).length, 2, `Patch drift: ${file}: ${before}`);
    text = text.replace(before, after);
  }
  writeFileSync(join(root, file), text);
}

// Preserve the pinned patch order. Resource-floor anchors depend on the agent
// write ceiling; native Git adds raw restrictions to read/presentation shapes;
// redirect completion and performance then refine those same final shapes.
applyManagedReadPatch(root, patch);
applyManagedGitPresentationPatch(root, patch);
applyManagedPromptLifecyclePatch(root, patch);
applyManagedForwardingObservationPatch(root, patch);
applyManagedAgentWriteFloorPatch(root, patch);
applyManagedSessionYoloPatch(root, patch);
applyManagedResourceFloorPatch(root, patch);
applyManagedForwardedPrincipalPatch(root, patch);
applyManagedToolCallPrincipalPatch(root, patch);
applyManagedHiddenToolsPatch(root, patch);
applyNativeGitPatch(root, patch);
applyRedirectArgvPatch(root, patch);
applyProfileDisplayPatch(root, patch);
applyPermissionPerformancePatch(root);
// Dynamic cd (including ~) stays upstream unknown-base handling; no speculative
// HOME-stability fold. Scratch provenance remains an active independent lane.
console.log(
  "Applied managed permission/provenance/profile/yolo, tool-call principal query, hidden-declaration tool list, original-command Git scope, redirect-buried argv and immutable resource-floor patches to pi-permission-system 32.0.3",
);
