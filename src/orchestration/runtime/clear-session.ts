import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PresetDefinition } from "../../shared/settings-store.mjs";
import { OrchestrationError } from "../core/ports.ts";
import type { DelegationSetting } from "../delegation.ts";
import type { PresetSelection } from "../routing.ts";

import {
  delegationEntry,
  delegationRecord,
  presetEntry,
  selectionRecord,
} from "./routing-records.ts";

const controlsEntry = "alehouse:clear-controls:v1";

interface ClearControls {
  childSkills: boolean;
  beerMugs: boolean;
  borderLabels: boolean;
}

/** Unlike routing records, these three switches apply only at the initial
 * start of the /clear destination. Resume/fork still load scoped defaults. */
export function clearControlsAtStart(
  reason: string,
  ctx: ExtensionContext,
): ClearControls | undefined {
  if (reason !== "new") return undefined;
  const records = ctx.sessionManager
    .getBranch()
    .flatMap((item) =>
      item.type === "custom" && item.customType === controlsEntry ? [item.data] : [],
    );
  if (!records.length) return undefined;
  const invalid = () =>
    new OrchestrationError("INVALID_CLEAR_CONTROLS", {
      record: controlsEntry,
      resolution: "Invalid /clear startup controls. Use /new for a fresh session.",
    });
  const [data] = records;
  if (records.length !== 1 || !data || typeof data !== "object") throw invalid();
  const prototype: unknown = Object.getPrototypeOf(data);
  if ((prototype !== null && prototype !== Object.prototype) || Reflect.ownKeys(data).length !== 3)
    throw invalid();
  const flag = (key: keyof ClearControls): boolean => {
    const field = Object.getOwnPropertyDescriptor(data, key);
    if (!field?.enumerable || typeof field.value !== "boolean") throw invalid();
    return field.value;
  };
  return {
    childSkills: flag("childSkills"),
    beerMugs: flag("beerMugs"),
    borderLabels: flag("borderLabels"),
  };
}

export function registerClearCommand(
  pi: ExtensionAPI,
  capture: (ctx: ExtensionContext) => {
    selection: PresetSelection;
    definition?: PresetDefinition;
    delegation: DelegationSetting;
    controls: ClearControls;
  },
): void {
  pi.registerCommand("clear", {
    description: "Start a new session with the current Alehouse worker and display settings",
    handler: async (_args, ctx) => {
      // Capture only live, allowed data before the native replacement can tear
      // down this Owner. No old session handles, message replay or config save.
      const { selection, definition, delegation, controls } = structuredClone(capture(ctx));
      await ctx.newSession({
        setup: async (manager) => {
          // Pi runs setup on the destination manager before binding the new
          // extension. Its ordinary branch restoration will see these records.
          manager.appendCustomEntry(
            presetEntry,
            selectionRecord(selection, definition ? { [selection.name]: definition } : undefined),
          );
          manager.appendCustomEntry(delegationEntry, delegationRecord(delegation));
          manager.appendCustomEntry(controlsEntry, controls);
        },
        withSession: async (session) => {
          if (session.hasUI) session.ui.notify("✓ New session started", "info");
        },
      });
    },
  });
}
