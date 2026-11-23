import {
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import { resolveTuiRenderer } from "../../shared/tui-renderer-identity.mjs";
import {
  createCenteredResize,
  type CenteredResize,
  type CenteredPanelLayout,
} from "../../shared/centered-resize.mjs";

export { centeredPanelTitleWidth } from "../../shared/centered-resize.mjs";

/** Same Pi adapter for Agents, Stats and the centered picker. Pi's fullscreen
 * compositor always paints overlays. A pure frame change doesn't need to ask
 * the underlying transcript for new content; other hosts can repaint normally. */
export function createCenteredPanel(options: CenteredPanelLayout): CenteredResize {
  const { host } = options;
  const renderer = resolveTuiRenderer(host);
  const repaintFrame = () => {
    if (renderer && renderer !== host && resolveTuiRenderer(host) !== renderer) return;
    const viewOnly: unknown = renderer && Reflect.get(renderer, "requestViewRender");
    if (typeof viewOnly === "function") Reflect.apply(viewOnly, renderer, []);
    else options.requestRender();
  };
  return createCenteredResize(
    {
      ...options,
      get minHeight() {
        return options.minHeight; // The live chrome placement changes this limit.
      },
      requestRender: repaintFrame,
    },
    { matchesKey, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth },
  );
}

/** Pi evaluates custom overlayOptions once, but reads the returned object's
 * dimensions each layout. Keep auto content measurement lazy, and don't let an
 * automatic minWidth push a maximized or manual frame out of its margins. */
export function centeredPanelOptions(
  resize: () => CenteredResize | undefined,
  auto: Pick<OverlayOptions, "width" | "minWidth" | "maxHeight" | "margin">,
): OverlayOptions {
  return {
    anchor: "center",
    get width() {
      return resize()?.width ?? auto.width;
    },
    get minWidth() {
      return resize()?.width === undefined ? auto.minWidth : undefined;
    },
    get maxHeight() {
      return resize()?.height ?? auto.maxHeight;
    },
    get margin() {
      return auto.margin;
    },
  };
}
