import { borderLabelsEnabled, popoverInlayWidth, popoverTitleRows } from "./popover-chrome.mjs";
import { watchPopoverCapture } from "./popover-close-hover.mjs";
import { frameGlyphs, POPOVER_CLOSE_COLUMNS } from "./popover-frame.mjs";

/** @typedef {import("./popover-frame.mjs").FrameEdges} FrameEdges */
const ALL_EDGES = Object.freeze({ top: true, bottom: true, left: true, right: true });
const MAXIMIZE_COLUMNS = 2; // ` □` or ` ▣`, immediately before the close tail.

/** Text budget for an inlaid or inset title in a resizable panel. @param {number} width */
export function centeredPanelTitleWidth(width) {
  return Math.max(0, popoverInlayWidth(width, "top", true) - MAXIMIZE_COLUMNS);
}

/**
 * @typedef {object} ResizeMouse
 * @property {string} type
 * @property {string} [button]
 * @property {number} [x]
 * @property {number} [y]
 * @property {number} [screenX]
 * @property {number} [screenY]
 * @property {number} [width]
 * @property {number} [height]
 * @property {boolean} [alt]
 * @property {boolean} [ctrl]
 * @property {boolean} [shift]
 */
/** @typedef {{ handled: true, render: false, capture?: never, target?: never }} ResizeMouseHandled */
/**
 * @typedef {object} ResizeMouseDispatchTarget
 * @property {{ render: (width: number) => readonly string[], invalidate: () => void, handleMouse: (event: ResizeMouse) => ResizeMouseHandled }} component
 * @property {number} originX
 * @property {number} originY
 * @property {number} width
 * @property {number} height
 */
/** @typedef {{ handled: true, render: false, capture: true, target: ResizeMouseDispatchTarget }} ResizeMouseDispatchResult */
/** @typedef {ResizeMouseHandled | ResizeMouseDispatchResult} ResizeMouseResult */
/**
 * @typedef {{
 *   readonly width: number | undefined,
 *   readonly height: number | undefined,
 *   readonly modal: boolean,
 *   readonly edges: FrameEdges | undefined,
 *   paint: (lines: string[], width: number, titleColumns?: number) => string[],
 *   input: (data: string) => boolean,
 *   mouse: (event: ResizeMouse, allowBorder?: boolean) => ResizeMouseResult | undefined,
 *   reset: () => void,
 * }} CenteredResize
 */
/** @typedef {{ host?: object, theme: import("./popover-chrome.mjs").ChromeTheme, terminal: () => { columns: number, rows: number }, minWidth: number, minHeight: number, independentAxes?: boolean, changed: () => void, requestRender: () => void }} CenteredPanelLayout */
/** @typedef {"f2" | "left" | "right" | "up" | "down" | "h" | "j" | "k" | "l" | "z" | "return" | "escape"} ResizeKey */
/**
 * @typedef {object} ResizeToolkit
 * @property {(data: string, key: ResizeKey) => boolean} matchesKey
 * @property {(text: string) => number} visibleWidth
 * @property {(text: string) => string} stripTerminalSequences
 * @property {(text: string, start: number, length: number) => string} sliceByColumn
 * @property {(text: string, width: number, ellipsis: string, pad: boolean) => string} truncateToWidth
 */
/** @typedef {{ width?: number, height?: number }} RequestedSize */
/** @typedef {{ normal: RequestedSize, maximized: boolean }} SizeSnapshot */
/** @typedef {{ w: number, h: number, rows: number, columns: number, titleY: number, titleEnd: number, lines: string[], glyphs: ReturnType<typeof frameGlyphs> }} PaintedBox */
/** @typedef {{ x: number, y: number, screenX: number, screenY: number }} PressPoint */
/** @typedef {{ side: -1 | 0 | 1, edge: -1 | 0 | 1 }} ResizeAxes */
/**
 * @typedef {{ kind: "button" } |
 *   ({ kind: "drag", box: PaintedBox, edges: FrameEdges, screenX: number, screenY: number } & ResizeAxes & SizeSnapshot)} ResizeGesture
 */

/** @param {number | undefined} value @returns {value is number} */
const isCell = (value) => typeof value === "number" && Number.isInteger(value);

/** Per-open sizing for a centered overlay. The host still owns placement,
 * capture and key decoding. Never infer a drag delta from local coordinates:
 * Pi retargets captured input against the bounds of the original press.
 * @param {CenteredPanelLayout} options
 * @param {ResizeToolkit} toolkit
 * @returns {CenteredResize}
 */
export function createCenteredResize(
  options,
  { matchesKey, truncateToWidth, sliceByColumn, stripTerminalSequences, visibleWidth },
) {
  /** @type {RequestedSize} */
  let normal = {};
  let maximized = false;
  /** @type {SizeSnapshot | undefined} */
  let beforeEdit;
  /** @type {PaintedBox | undefined} */
  let painted;
  /** Last normal frame, including partially automatic sizes. A key immediately
   * after unzoom must use its content size, not the still-painted maximized box.
   * @type {Pick<PaintedBox, "w" | "h" | "rows" | "columns" | "titleY"> | undefined} */
  let lastNormal;
  /** @type {ResizeGesture | undefined} */
  let gesture;
  /** @type {ReturnType<typeof watchPopoverCapture>} */
  let watch;
  let deliveringPress = false;
  const metrics = {
    width: visibleWidth,
    /** @param {string} text @param {number} columns */
    clip: (text, columns) => truncateToWidth(text, columns, "", false),
  };
  let fresh = false;
  /** @type {ResizeMouseHandled} */
  const handled = { handled: true, render: false }; // changed()/requestRender() own the repaint.
  /** @param {number} value @param {number} min @param {number} max */
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  /** @param {number} value */
  const extent = (value) => Math.max(1, Math.floor(value) - 2);
  const width = () => dimension(normal.width, options.terminal().columns);
  const height = () => dimension(normal.height, options.terminal().rows, options.minHeight);
  /** @param {number | undefined} value @param {number} available @param {number} min */
  function dimension(value, available, min = 1) {
    if (!Number.isFinite(available) || available < 1) return undefined;
    const max = extent(available);
    // An automatic frame can already reach a terminal edge on a narrow screen.
    // Preserve that still-fitting width/height when adjusting only the other axis.
    if (maximized || (value !== undefined && value > available)) return max;
    // Inset labels need more rows. Apply their live floor without overwriting
    // the saved border-label height, or turning automatic sizing into manual.
    return value === undefined ? undefined : Math.max(value, Math.min(min, max));
  }
  function changed() {
    fresh = false; // No new pointer targets until Pi paints the new geometry/controls.
    options.changed();
  }
  function toggleMaximized() {
    maximized = !maximized; // Automatic sizing is a valid restore target too.
    changed();
  }
  /** @param {boolean} undo */
  function leave(undo) {
    if (undo && beforeEdit) ({ normal, maximized } = beforeEdit);
    beforeEdit = undefined;
    changed();
  }
  /** @param {PaintedBox | undefined} box @returns {box is PaintedBox} */
  function current(box) {
    const { rows, columns } = options.terminal();
    return (
      box !== undefined &&
      box.rows === rows &&
      box.columns === columns &&
      box.titleY === (borderLabelsEnabled() ? 0 : 1)
    );
  }
  /**
   * @param {number} w @param {number} h @param {number} dx @param {number} dy
   * @param {SizeSnapshot} [start]
   */
  function adjust(w, h, dx, dy, start = { normal, maximized }) {
    const { columns, rows } = options.terminal();
    const nextWidth = dx
      ? clamp(w + 2 * dx, Math.min(w, options.minWidth), Math.max(w, extent(columns)))
      : w;
    const nextHeight = dy
      ? clamp(h + 2 * dy, Math.min(h, options.minHeight), Math.max(h, extent(rows)))
      : h;
    if (nextWidth === w && nextHeight === h) {
      // Reaching a limit isn't a resize. Returning to the press restores the
      // original sizing modes, even if a corner overshoots a clamped edge.
      if (normal === start.normal && maximized === start.maximized) return;
      ({ normal, maximized } = start);
      changed();
      return;
    }
    // Preserve a requested dimension even if the terminal currently clips it.
    // A live content pane can leave an untouched axis automatic; other views
    // freeze the visible box to avoid reflow on an axis the user didn't drag.
    const keepAuto = options.independentAxes && !start.maximized;
    const next = {
      width:
        nextWidth !== w || start.maximized
          ? nextWidth
          : (start.normal.width ?? (keepAuto ? undefined : w)),
      height:
        nextHeight !== h || start.maximized
          ? nextHeight
          : (start.normal.height ?? (keepAuto ? undefined : h)),
    };
    if (!maximized && next.width === normal.width && next.height === normal.height) return;
    normal = next;
    maximized = false;
    changed();
  }
  function edges() {
    if (beforeEdit) {
      const { rows, columns } = options.terminal();
      return extent(columns) >= 30 && extent(rows) >= options.minHeight ? ALL_EDGES : undefined;
    }
    // Stop/resume may drop native capture outside input dispatch, without a
    // component blur. A repaint must not resurrect the old press or its strokes.
    if (watch && !deliveringPress && !watch.held()) cancelGesture(false);
    return gesture?.kind === "drag" && current(gesture.box) ? gesture.edges : undefined;
  }
  function cancelGesture(render = true) {
    const redraw = render && gesture?.kind === "drag" && (!watch || watch.current());
    gesture = undefined;
    watch?.dispose();
    watch = undefined;
    if (redraw) options.requestRender(); // Appearance only: don't retire valid body hits.
  }
  function reset() {
    cancelGesture();
    painted = undefined;
    fresh = false;
    if (beforeEdit) leave(true);
  }
  /** @param {PaintedBox | undefined} a @param {PaintedBox} b */
  const sameBox = (a, b) =>
    a &&
    a.w === b.w &&
    a.h === b.h &&
    a.rows === b.rows &&
    a.columns === b.columns &&
    a.titleY === b.titleY;
  /** @param {ResizeMouse} event */
  function pointerBox(event) {
    const box = painted;
    if (
      !fresh ||
      !current(box) ||
      (event.width !== undefined && event.width !== box.w) ||
      (event.height !== undefined && event.height !== box.h)
    )
      return;
    return box;
  }
  /** @param {Pick<ResizeMouse, "x" | "y">} point @param {PaintedBox} box */
  function hitsMaximize({ x, y }, { w, titleY }) {
    return !beforeEdit && y === titleY && x === w - POPOVER_CLOSE_COLUMNS - 1;
  }
  /** Test the frame the user actually sees, not an entire rectangular band:
   * agents can have clickable footer labels, an input, or a scroll thumb. Do
   * not claim their cells, even when they occupy the outermost row/column.
   * @param {PressPoint} point @param {PaintedBox} box @returns {ResizeAxes | undefined}
   */
  function border({ x, y }, { w, h, lines, glyphs: g, titleEnd }) {
    if (beforeEdit || !isCell(x) || !isCell(y) || x < 0 || x >= w || y < 0 || y >= h) return;
    const side = x === 0 ? -1 : x === w - 1 ? 1 : 0;
    const edge = y === 0 ? -1 : y === h - 1 ? 1 : 0;
    const line = lines[y];
    if ((!side && !edge) || line === undefined || (y === 0 && x >= 3 && x < titleEnd)) return;
    const cell = stripTerminalSequences(sliceByColumn(line, x, 1));
    const glyph =
      edge === 0
        ? side < 0
          ? g.left
          : g.right
        : (edge < 0 ? [g.tl, g.top, g.tr] : [g.bl, g.bottom, g.br])[side + 1];
    if (cell === glyph) return { side, edge };
  }
  /** Give Pi a distinct target for this press, just as it does when routing to
   * a child component. Only events actually delivered to *that capture* can
   * resize. Terminal focus-out drops the native target without blurring the
   * panel; an unmatched release delivered to the panel itself is harmless.
   * @param {ResizeGesture} start @param {PaintedBox} box @param {PressPoint} point
   * @returns {ResizeMouseDispatchResult}
   */
  function capture(start, box, { x, y, screenX, screenY }) {
    gesture = start;
    /** @type {ResizeMouseDispatchTarget["component"]} */
    const component = {
      render: () => [],
      invalidate() {},
      handleMouse(next) {
        if (gesture !== start) return handled;
        if (watch && !watch.current()) {
          cancelGesture(false); // Old capture behind a replaced stable TUI reference.
          return handled;
        }
        if (next.type === "release") cancelGesture();
        if (
          next.ctrl ||
          next.alt ||
          next.shift ||
          (next.button !== "left" && !(next.type === "release" && next.button === "none"))
        ) {
          cancelGesture();
          return handled;
        }
        if (start.kind === "button") {
          const box = pointerBox(next);
          if (!box || !hitsMaximize(next, box) || next.type === "press") cancelGesture();
          else if (next.type === "release") toggleMaximized();
        } else if (next.type === "drag" || next.type === "release") {
          if (!current(start.box) || !isCell(next.screenX) || !isCell(next.screenY))
            cancelGesture();
          else {
            const dx = (next.screenX - start.screenX) * start.side,
              dy = (next.screenY - start.screenY) * start.edge;
            adjust(start.box.w, start.box.h, dx, dy, start);
          }
        } else cancelGesture();
        return handled;
      },
    };
    if (start.kind === "drag") {
      watch = watchPopoverCapture(options.host, component, cancelGesture);
      deliveringPress = true; // Pi sets native capture after our press handler returns.
      try {
        options.requestRender(); // Show the grabbed edge even at a size limit.
      } finally {
        deliveringPress = false;
      }
    }
    return {
      ...handled,
      capture: true,
      target: {
        component,
        originX: screenX - x,
        originY: screenY - y,
        width: box.w,
        height: box.h,
      },
    };
  }
  return {
    get width() {
      return width();
    },
    get height() {
      return height();
    },
    get modal() {
      return beforeEdit !== undefined;
    },
    get edges() {
      return edges();
    },
    reset,
    paint(lines, w, titleColumns = 0) {
      const { rows, columns } = options.terminal();
      const h = lines.length,
        titleY = borderLabelsEnabled() ? 0 : 1;
      const originalTitle = lines[titleY];
      // Only a complete frame can advertise a target. Narrow/short fallback
      // notices, dry layouts and hidden components must not gain controls.
      if (
        !Number.isInteger(w) ||
        w < 30 ||
        extent(columns) < 30 ||
        !Number.isInteger(columns) ||
        w > columns ||
        !Number.isInteger(rows) ||
        extent(rows) < options.minHeight ||
        h > rows ||
        h < titleY + 2 ||
        originalTitle === undefined
      ) {
        reset();
        return lines;
      }
      const out = [...lines];
      if (gesture?.kind === "drag" && !current(gesture.box)) cancelGesture();
      const active = edges();
      // Both inlaid title forms start at column 3. Even a literal rule in a
      // task/model name is text, not a resize handle. Leave the actual tail free.
      const titleEnd = titleY === 0 ? 3 + Math.min(titleColumns, centeredPanelTitleWidth(w)) : 0;
      const box = {
        w,
        h,
        rows,
        columns,
        titleY,
        titleEnd,
        lines: out,
        glyphs: frameGlyphs(active),
      };
      if (gesture?.kind === "button" && !sameBox(painted, box)) cancelGesture();
      // A live, still-automatic frame can reflow while the mouse is held. Base
      // the first delta on the latest paint so the untouched axis doesn't jump.
      if (gesture?.kind === "drag" && normal === gesture.normal && maximized === gesture.maximized)
        gesture.box = box;
      painted = box;
      if (!maximized) lastNormal = { w, h, rows, columns, titleY };
      fresh = true;
      if (beforeEdit) {
        const hint =
          w >= 58
            ? "Resize: hjkl/arrows · z zoom · Enter keep · Esc undo"
            : "Resize: hjkl z Enter/Esc";
        const title = popoverTitleRows(options.theme, w, hint, metrics, false, false, active);
        out[titleY] = title[titleY] ?? originalTitle;
      } else {
        // Reserve only the two cells for maximize; leave the existing close tail intact.
        const tail = w - POPOVER_CLOSE_COLUMNS;
        out[titleY] =
          truncateToWidth(originalTitle, tail - MAXIMIZE_COLUMNS, "", true) +
          (maximized ? " ▣" : " □") +
          sliceByColumn(originalTitle, tail, POPOVER_CLOSE_COLUMNS);
      }
      return out;
    },
    input(data) {
      /** @param {ResizeKey} name */
      const key = (name) => matchesKey(data, name);
      if (!beforeEdit) {
        if (!key("f2") || !current(painted)) return false;
        cancelGesture(); // Retire a captured mouse press before taking keyboard ownership.
        beforeEdit = { normal, maximized };
        changed();
      } else if (key("escape") || key("f2")) leave(true);
      else if (key("return")) leave(false);
      else if (current(painted)) {
        if (key("z")) toggleMaximized();
        else {
          const dx = key("right") || key("l") ? 1 : key("left") || key("h") ? -1 : 0;
          const dy = key("down") || key("j") ? 1 : key("up") || key("k") ? -1 : 0;
          const auto =
            lastNormal &&
            lastNormal.columns === painted.columns &&
            lastNormal.rows === painted.rows &&
            lastNormal.titleY === painted.titleY
              ? lastNormal
              : undefined;
          const w = width() ?? auto?.w,
            h = height() ?? auto?.h;
          if ((dx || dy) && w !== undefined && h !== undefined) adjust(w, h, dx, dy);
        }
      }
      return true; // Resizing must not type into a draft/search or activate the panel below.
    },
    mouse(event, allowBorder = true) {
      const { type, button, x, y, screenX, screenY } = event;
      const plain = !event.ctrl && !event.alt && !event.shift;
      if (type === "press") {
        cancelGesture();
        if (
          button === "left" &&
          plain &&
          isCell(screenX) &&
          isCell(screenY) &&
          x !== undefined &&
          y !== undefined
        ) {
          const box = pointerBox(event);
          if (box) {
            const point = { x, y, screenX, screenY };
            if (hitsMaximize(point, box)) return capture({ kind: "button" }, box, point);
            const axes = allowBorder ? border(point, box) : undefined;
            if (axes)
              return capture(
                {
                  kind: "drag",
                  box,
                  screenX,
                  screenY,
                  ...axes,
                  normal,
                  maximized,
                  edges: {
                    left: axes.side < 0,
                    right: axes.side > 0,
                    top: axes.edge < 0,
                    bottom: axes.edge > 0,
                  },
                },
                box,
                point,
              );
          }
        }
      }
      return beforeEdit ? handled : undefined;
    },
  };
}
