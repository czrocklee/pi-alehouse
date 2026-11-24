import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CHANGES_INDICATOR,
  FOOTER_INDICATOR_CLICK_EVENT,
  type FooterIndicatorClick,
} from "../../shared/overlay-protocol.mjs";
import type { ChildActivityRegistry } from "../runtime/activity-observer.ts";

const STATUS_UNCERTAIN = Symbol("changes-footer-status");

/** Publish cached Net counts, independent of popup mode and never during paint. */
export function bindChangesFooter(
  ui: Pick<ExtensionContext["ui"], "setStatus">,
  events: EventBus,
  changes: Pick<ChildActivityRegistry, "getOwnerChangeCounts" | "subscribeOwnerChangeCounts">,
  toggle: () => Promise<void>,
  reportError: (error: unknown) => void,
): () => void {
  let active = true;
  let published: string | undefined | typeof STATUS_UNCERTAIN;
  const update = () => {
    if (!active) return;
    const { paths, added, removed, partial, unknownPaths } = changes.getOwnerChangeCounts();
    const incomplete = partial || unknownPaths > 0;
    let text = incomplete ? "+? −?" : undefined;
    if (added || removed || (paths > 0 && !incomplete))
      text = `+${added} −${removed}${incomplete ? " …" : ""}`;
    if (text === published) return;
    try {
      ui.setStatus(CHANGES_INDICATOR, text);
      published = text;
    } catch {
      // Pi stores the status before requesting a render, which can throw.
      published = STATUS_UNCERTAIN;
    }
  };
  const observeToggleError = (error: unknown) => {
    if (!active) return; // The pending click can settle after teardown.
    try {
      reportError(error);
    } catch {
      // This event boundary has no Promise consumer, even for reporting failures.
    }
  };
  const unwatchCounts = changes.subscribeOwnerChangeCounts(update);
  const unwatchClick = events.on(FOOTER_INDICATOR_CLICK_EVENT, (data) => {
    const click = data as FooterIndicatorClick | undefined;
    if (!active || click?.key !== CHANGES_INDICATOR) return;
    click.handled = true;
    if (published === undefined) return;
    try {
      toggle().catch(observeToggleError);
    } catch (error) {
      observeToggleError(error);
    }
  });
  update();
  return () => {
    if (!active) return;
    active = false;
    try {
      unwatchCounts();
    } finally {
      try {
        unwatchClick();
      } finally {
        if (published !== undefined) ui.setStatus(CHANGES_INDICATOR, undefined);
      }
    }
  };
}
