import { createPopoverCloseControl } from "../../shared/popover-close-control.mjs";
import { createPopoverTextSelection } from "../../shared/popover-text-selection.mjs";
import {
  onBorderLabelsChange,
  popoverChromeCloseHit,
  popoverChromeLayout,
  popoverTextRect,
} from "../../shared/popover-chrome.mjs";
import {
  compositeTuiLine,
  decodeKittyPrintable,
  Input,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { RunView } from "../core/contracts.ts";
import { HUMAN_STEER_MAX_UNITS } from "../presentation/human-steer-text.ts";
import { type Theme, type TranscriptFrame, type TranscriptRows } from "./format.ts";
import { popoverBottom, popoverInlayWidth, popoverLabelRows, popoverSide } from "./popover.ts";
import { plainText, wrapPlainText as wrapText } from "./text.ts";
import { renderDetailActionsMenu } from "./detail-actions-menu.ts";
import {
  renderComposeFooter,
  renderDetailFields,
  renderDetailFooter,
  renderDetailTitle,
  renderDetailAttention,
  renderDetailComposeHeading,
  renderDetailInfo,
  renderDetailSummary,
  getDetailAttentionNotes,
  type DetailAttentionNote,
  type DetailFooterFrame,
  type DetailInput,
  type DetailLive,
} from "./agent-detail-fields.ts";

export { wrapText };
export { renderDetailFields, renderDetailTitle, type DetailInput, type DetailLive };

const CONFIRM_LIFETIME_MS = 10_000;
const STEER_NOTICE_MS = 5_000;
type StopTarget = Pick<RunView, "owner_id" | "generation" | "agent_id" | "run_id">;
interface PaintDimensions {
  columns: number;
  rows: number;
  width: number;
}
interface StopAction {
  kind: "stop" | "confirm";
  from: number;
  to: number;
}
interface ComposePaint {
  target: StopTarget;
  dimensions: PaintDimensions;
}
interface StopPaint extends ComposePaint {
  action: StopAction;
}
interface StopConfirmation {
  target: StopTarget;
  expiresAt: number;
  dimensions: PaintDimensions;
}
/** One clickable chrome range: an Agent tab (or `+N`, `‹`, `›`), the tail,
 * actions-menu control/item, or page-local back link. Coordinates are pane cells. */
type ChromeHit = { y: number; from: number; to: number } & (
  { kind: "agent"; agent_id: string } | { kind: "tail" | "transcript" | "info" | "tools" | "menu" }
);
interface ChromePaint {
  dimensions: PaintDimensions;
  hits: ChromeHit[];
}
interface TranscriptRead {
  target: StopTarget;
  source: TranscriptRows;
  width: number;
  anchor: unknown;
}
/** An unsent human message, bound to the Run it was started for. */
export interface DetailDraft {
  target: StopTarget;
  text: string;
}
interface Compose {
  target: StopTarget;
  input: Input;
  empty: boolean;
  paste: string | undefined;
  /** A paste that never terminates stops owning the keyboard at this time. */
  pasteDeadline: number;
  /** Separate input chunks that together may begin a split paste marker. */
  pastePrefix: string[];
}
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** Split paste chunks arrive back to back; a lost terminator must not keep
 * Esc and Enter captured as data. The buffer is bounded the same way. */
const PASTE_SETTLE_MS = 500;
const PASTE_BUFFER_UNITS = 4 * 16_384;
/** Trimmed drafts beyond the admitted steer size cannot be sent. */
const overLimit = (compose: Compose): boolean =>
  compose.input.getValue().trim().length > HUMAN_STEER_MAX_UNITS;
/** Match Input's single-line paste behavior, but never retain terminal controls.
 * The shared sanitizer preserves script/emoji joiners, selectors and graphemes. */
const composeText = (text: string): string =>
  plainText(text.replace(/\t/g, "    ")).replace(/\n+/g, " ");
const sameRun = (target: StopTarget, view: RunView | undefined): boolean =>
  !!view &&
  view.agent_id === target.agent_id &&
  view.owner_id === target.owner_id &&
  view.generation === target.generation &&
  view.run_id === target.run_id;
/** Messages only reach live execution: a queued, stopping or settled Run has no
 * open input path, and this control never starts a continuation. */
const steerable = (view: RunView): boolean =>
  view.status === "running" && !view.execution_exited && !view.stop_reason;
const sameStop = (target: StopTarget, view: RunView | undefined, selected: string): boolean =>
  selected === target.agent_id &&
  !!view &&
  view.agent_id === target.agent_id &&
  view.owner_id === target.owner_id &&
  view.generation === target.generation &&
  view.run_id === target.run_id &&
  stoppable(view);
/** Stop requests only apply to live execution, never settled or draining work. */
const stoppable = (view: RunView): boolean =>
  (view.status === "queued" || view.status === "running") &&
  !view.execution_exited &&
  !view.stop_reason;
/** Inlaid bands cost one row each; an inset band costs an outer rule, a
 * content row and a separator. The shared layout owns those row coordinates. */
const MIN_VIEWPORT = 3;
const DOCKED_HEIGHT_PCT = 70;
const FLOATING_HEIGHT_PCT = 84;
const COMPOSE_ROWS = 2;

/** Pads a styled row to `columns` display columns; ANSI has no width of its own. */
const padTo = (line: string, columns: number): string =>
  line + " ".repeat(Math.max(0, columns - visibleWidth(line)));

export interface PaneTui {
  readonly terminal: { readonly columns: number; readonly rows: number };
  requestRender(): void;
}
/** The pointer event as the pane reads it; a structural subset of pi-tui's. */
export interface PaneMouseEvent {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  wheelDelta?: number;
  /** Consecutive clicks reported by the host's normalized mouse dispatcher. */
  clickCount?: number;
}
export interface DetailPaneOptions {
  tui: PaneTui;
  theme: Theme;
  /** Re-read every frame, so the pane cannot disagree with the widget or the tools. */
  snapshot: () => { agent_id: string; input: DetailInput }[];
  /** Actions bypass all presentation caches. */
  freshSnapshot?: () => { agent_id: string; input: DetailInput }[];
  /** Cheap data invalidation hint, independent of animation and elapsed time. */
  revision?: () => unknown;
  visible?: () => boolean;
  invalidate?: () => void;
  /** One Agent's transcript rows, created once per Agent and reused; undefined
   * when its child session has not started and there is nothing to render. */
  transcript: (agent_id: string) => TranscriptRows | undefined;
  initial: string;
  done: () => void;
  /** The Agent on screen changed. Lets a caller that reopens the pane -- after
   * yielding to a permission dialog -- come back to what was being watched. */
  onSelect?: (agent_id: string) => void;
  /** Request cancellation through the host's Owner. Bound to the painted Run,
   * not whichever task this Agent might be running when a later callback fires. */
  onStop?: (run_id: string) => void;
  /** Submit one human message to the Run the draft was started for. Returns
   * whether the draft is spent; a refused message stays in the input. */
  onSteer?: (run_id: string, message: string) => boolean;
  /** Match the host's public tools-expand binding. The transcript is a string
   * projection, so this toggles all settled cards, like T, not a hovered card. */
  expandToolsKey?: (data: string) => boolean;
  /** An unsent draft to restore; ignored unless its Run is still the one shown. */
  draft?: DetailDraft;
  /** Draft text changed, or was discarded by the user (undefined). */
  onDraft?: (draft: DetailDraft | undefined) => void;
  /**
   * Draw a border. Set when the pane floats as a centred overlay, where nothing
   * brackets it; docked it sits between the agents widget and Pi's footer, which
   * already bound it, so a frame would cost columns for nothing.
   */
  frame?: boolean;
}

/**
 * The docked detail pane: one agent at a time, ←/→ between them, ↑/↓ through the
 * body. Esc unwinds one layer at a time: the menu, an armed Stop, a draft, the
 * Info page, and only then closes the pane. Mounted through `ui.custom`'s NON-overlay path — Pi's
 * regular-mode renderer composites overlays into the buffer that backs
 * scrollback, so an overlay would bake this pane's rows into terminal history.
 */
export class DetailPane {
  private scrollOffset = 0;
  /** Follow the live tail, as the main conversation does, until the reader
   * scrolls away from the end; reaching the end again resumes following. */
  private followTail = true;
  private selected: string;
  private closed = false;
  /** Body height as last painted. Keys scroll what is on screen, so they read
   * this instead of rendering a second copy of a transcript that can run long. */
  private painted = 0;
  /** Width of the last framed paint; the close control's hit area follows it. */
  private paintedWidth = 0;
  private paintedHeight = 0;
  private layout = popoverChromeLayout();
  private readonly unwatchBorderLabels: () => void;
  private fixedHeight = 0;
  private composeRows = 0;
  private bodyFloor = MIN_VIEWPORT;
  private hiddenNotes = 0;
  private readonly wrapped = new Map<string, { width: number; rows: string[] }>();
  private transcriptRead: TranscriptRead | undefined;
  private pendingToolAnchor: TranscriptRead | undefined;
  private info = false;
  private transcriptPosition: { offset: number; follow: boolean } | undefined;
  private toolsExpanded = false;
  private chromePaint: ChromePaint | undefined;
  private messageAction: DetailFooterFrame["messageAction"];
  private menuPaint: ComposePaint | undefined;
  private actionsMenu: (ComposePaint & { selected: 0 | 1 }) | undefined;
  private menuDismissPress = false;
  /** Admission only: the UI has no delivery acknowledgement to correlate. */
  private recentSteer: { target: StopTarget; expiresAt: number } | undefined;
  private stopPaint: StopPaint | undefined;
  /** M starts from the Run actually painted, never a fresh replacement. */
  private composePaint: ComposePaint | undefined;
  private confirmation: StopConfirmation | undefined;
  /** Message mode. Separate from Stop intent: it has no side effect until Enter
   * and survives repaints, scrolling and permission hiding. */
  private compose: Compose | undefined;
  private frame = 0;
  private animating = false;
  private renderedRevision: unknown;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly closeHover: ReturnType<typeof createPopoverCloseControl>;
  private readonly textSelection: ReturnType<typeof createPopoverTextSelection>;

  constructor(private readonly options: DetailPaneOptions) {
    this.textSelection = createPopoverTextSelection({ host: options.tui, component: this });
    this.selected = options.initial;
    this.layout = popoverChromeLayout({ framed: !!options.frame });
    const draft = options.draft;
    if (draft) {
      const view = options.snapshot().find((entry) => entry.agent_id === this.selected)?.input.view;
      if (options.onSteer && draft.target.agent_id === this.selected && sameRun(draft.target, view))
        this.beginCompose(draft.target, draft.text);
      else options.onDraft?.(undefined);
    }
    this.closeHover = createPopoverCloseControl({
      closeHit: popoverChromeCloseHit,
      host: options.tui,
      requestRender: () => options.tui.requestRender(),
    });
    this.unwatchBorderLabels = onBorderLabelsChange(() => {
      if (this.closed) return;
      this.layout = popoverChromeLayout({ framed: !!options.frame });
      this.resetCloseHover(false);
      this.resetStopInteraction();
      this.painted = 0;
      this.paintedHeight = 0;
      options.tui.requestRender();
    });
    this.timer = setInterval(() => {
      if (this.closed) return;
      if (this.options.visible?.() === false) {
        this.actionsMenu = undefined;
        this.menuPaint = undefined;
        this.chromePaint = undefined;
        this.resetStopInteraction();
        return;
      }
      const staleStop = this.staleStopPaint();
      const revision = this.options.revision?.();
      if (
        !staleStop &&
        !this.animating &&
        revision !== undefined &&
        revision === this.renderedRevision
      )
        return;
      this.frame++;
      this.options.tui.requestRender();
    }, 120);
  }

  /**
   * The agent on screen, and where it sits in the list. When the selected one
   * has exited, the first row is not merely painted: it is SELECTED, so the
   * footer's position, the left/right neighbours and the host's notion of which
   * agent is open all describe the same agent as the body does.
   */
  private current(): { entries: { agent_id: string; input: DetailInput }[]; index: number } {
    const entries = this.options.snapshot();
    const index = entries.findIndex((entry) => entry.agent_id === this.selected);
    if (index === -1 && entries[0]) this.adopt(entries[0].agent_id);
    return { entries, index: index === -1 ? 0 : index };
  }
  /** Move the selection, resetting everything that described the old one. */
  private adopt(agent_id: string): void {
    this.textSelection.reset();
    this.selected = agent_id;
    this.scrollOffset = 0;
    this.followTail = true;
    this.painted = 0;
    this.info = false;
    this.actionsMenu = undefined;
    this.menuPaint = undefined;
    this.transcriptPosition = undefined;
    this.recentSteer = undefined;
    this.transcriptRead = undefined;
    this.pendingToolAnchor = undefined;
    this.chromePaint = undefined;
    this.resetStopInteraction();
    this.endCompose();
    this.options.onSelect?.(agent_id);
  }
  private select(entries: { agent_id: string }[], index: number): void {
    const next = entries[(index + entries.length) % entries.length];
    if (!next || next.agent_id === this.selected) return;
    this.adopt(next.agent_id);
  }

  /** A widget-row click is a direct selection, and clicking the selected row
   * again is the mouse equivalent of Esc. */
  activate(agent_id: string): void {
    if (this.closed) return;
    if (agent_id === this.selected) {
      this.closed = true;
      this.resetCloseHover();
      this.resetStopInteraction();
      this.endCompose();
      this.options.done();
      return;
    }
    if (!this.options.snapshot().some((entry) => entry.agent_id === agent_id)) return;
    this.adopt(agent_id);
    this.options.tui.requestRender();
  }

  isOpen(): boolean {
    return !this.closed;
  }

  /** Retire command evidence/Stop intent, not tabs or an existing sticky draft.
   * Selection geometry belongs to its paint, independently of Stop state. */
  resetStopInteraction(): void {
    this.stopPaint = undefined;
    this.composePaint = undefined;
    this.messageAction = undefined;
    this.confirmation = undefined;
  }

  /** Permission yield can hide the mounted pane without disposing it. */
  resetCloseHover(render = true): void {
    this.textSelection.reset();
    this.actionsMenu = undefined;
    this.menuPaint = undefined;
    this.menuDismissPress = false;
    this.paintedWidth = 0;
    this.chromePaint = undefined;
    this.composePaint = undefined;
    this.messageAction = undefined;
    this.closeHover.reset(render);
  }

  /** Timers request repaint without consuming the still-visible confirmation:
   * its first Esc must cancel, even if the render request has not been serviced. */
  private staleStopPaint(width?: number): boolean {
    const painted =
      this.stopPaint?.dimensions ??
      this.confirmation?.dimensions ??
      this.composePaint?.dimensions ??
      this.chromePaint?.dimensions;
    return !!(
      (this.confirmation && performance.now() >= this.confirmation.expiresAt) ||
      (painted && this.geometryChanged(painted, width))
    );
  }

  /** Actions and rendering retire expired intent/stale geometry immediately.
   * A delayed repaint cannot extend the confirmation's ten-second lifetime. */
  private retireStopPaint(width?: number): void {
    const stale = this.staleStopPaint(width);
    if (this.chromePaint && this.geometryChanged(this.chromePaint.dimensions, width))
      this.chromePaint = undefined;
    if (this.actionsMenu && this.geometryChanged(this.actionsMenu.dimensions, width)) {
      this.actionsMenu = undefined;
      this.menuPaint = undefined;
      this.chromePaint = undefined;
    }
    if (!stale) return;
    this.resetStopInteraction();
    this.options.tui.requestRender();
  }

  private geometryChanged(paint: PaintDimensions, width?: number): boolean {
    const terminal = this.options.tui.terminal;
    return (
      paint.columns !== terminal.columns ||
      paint.rows !== terminal.rows ||
      (width !== undefined && paint.width !== width)
    );
  }

  /** Actions get fresh authority; rendering reuses its one captured snapshot. */
  private validStop(target: StopTarget): boolean {
    const entry = (this.options.freshSnapshot ?? this.options.snapshot)().find(
      (entry) => entry.agent_id === target.agent_id,
    );
    return sameStop(target, entry?.input.view, this.selected);
  }

  private requestStop(): void {
    const paint = this.stopPaint;
    if (
      !paint ||
      paint.action.kind !== "stop" ||
      !this.options.onStop ||
      !this.validStop(paint.target)
    ) {
      this.resetStopInteraction();
      return;
    }
    this.actionsMenu = undefined;
    this.resetStopInteraction();
    this.confirmation = {
      target: paint.target,
      dimensions: paint.dimensions,
      expiresAt: performance.now() + CONFIRM_LIFETIME_MS,
    };
    this.options.tui.requestRender();
  }

  private confirmStop(): void {
    const confirmation = this.confirmation,
      paint = this.stopPaint;
    if (
      !confirmation ||
      !paint ||
      paint.action.kind !== "confirm" ||
      paint.target !== confirmation.target ||
      !this.options.onStop
    )
      return;
    const valid = performance.now() < confirmation.expiresAt && this.validStop(confirmation.target);
    // Consume intent before invoking a host callback, including a throwing one.
    this.resetStopInteraction();
    if (valid) this.options.onStop(confirmation.target.run_id);
    this.options.tui.requestRender();
  }

  private beginCompose(target: StopTarget, text = ""): void {
    this.actionsMenu = undefined;
    this.recentSteer = undefined;
    const input = new Input({
      prompt: this.options.theme.fg("dim", "› "),
      placeholder: "message this Agent",
      placeholderStyle: (text) => this.options.theme.fg("dim", text),
    });
    // The pane holds focus, so its input owns the hardware cursor (and the IME).
    input.focused = true;
    const safe = composeText(text);
    // setValue clamps the existing cursor (initially zero). Public paste input
    // instead restores a nonempty draft with its caret at the end, including IME.
    if (safe) input.handleInput(PASTE_START + safe + PASTE_END);
    input.onSubmit = () => this.submitCompose();
    input.onEscape = () => {
      this.endCompose();
      this.options.tui.requestRender();
    };
    this.compose = {
      target,
      input,
      empty: false,
      paste: undefined,
      pasteDeadline: 0,
      pastePrefix: [],
    };
    if (safe !== text) this.options.onDraft?.(safe ? { target, text: safe } : undefined);
  }

  /** The user discarded or spent the draft. Disposal alone keeps it with the host. */
  private endCompose(): void {
    if (!this.compose) return;
    this.compose = undefined;
    this.options.onDraft?.(undefined);
  }

  /** Fresh authority, as for Stop: the draft only ever reaches its original Run. */
  private composeTarget(snapshot = this.options.snapshot): RunView | undefined {
    const compose = this.compose;
    if (!compose || this.selected !== compose.target.agent_id) return undefined;
    const view = snapshot().find((entry) => entry.agent_id === compose.target.agent_id)?.input.view;
    return sameRun(compose.target, view) && steerable(view!) ? view : undefined;
  }

  private submitCompose(): void {
    const compose = this.compose;
    if (!compose || !this.options.onSteer) return;
    const message = compose.input.getValue().trim();
    if (!message) {
      compose.empty = true;
      this.options.tui.requestRender();
      return;
    }
    // The footer already says so while typing; Enter never sends a draft that
    // core would reject, and the text stays for the user to shorten.
    if (message.length > HUMAN_STEER_MAX_UNITS) {
      this.options.tui.requestRender();
      return;
    }
    if (
      this.paintedHeight === 0 ||
      !this.bounds(this.painted).fits ||
      !this.composeTarget(this.options.freshSnapshot ?? this.options.snapshot)
    ) {
      this.options.tui.requestRender();
      return;
    }
    this.recentSteer = undefined;
    if (this.options.onSteer(compose.target.run_id, message) && this.compose === compose) {
      this.recentSteer = {
        target: compose.target,
        expiresAt: performance.now() + STEER_NOTICE_MS,
      };
      this.endCompose();
      this.followTail = true;
    }
    this.options.tui.requestRender();
  }

  private requestCompose(): void {
    const paint = this.composePaint;
    if (!paint || !this.options.onSteer || this.confirmation) return;
    const view = (this.options.freshSnapshot ?? this.options.snapshot)().find(
      (entry) => entry.agent_id === this.selected,
    )?.input.view;
    if (
      this.selected !== paint.target.agent_id ||
      !sameRun(paint.target, view) ||
      !steerable(view!)
    ) {
      this.resetStopInteraction();
      return;
    }
    this.resetStopInteraction();
    this.beginCompose(paint.target);
    this.options.tui.requestRender();
  }

  /** Paste is sanitized before SDK insertion. Keyboard edits (including Kitty
   * printable decoding, undo and yank) are sanitized before preview/host storage. */
  private editCompose(compose: Compose, data: string, paste = false): void {
    const before = compose.input.getValue();
    compose.input.handleInput(paste ? PASTE_START + composeText(data) + PASTE_END : data);
    const raw = compose.input.getValue(),
      text = composeText(raw);
    if (raw !== text) compose.input.setValue(text);
    if (this.compose === compose && text !== before) {
      compose.empty = false;
      this.options.onDraft?.(text ? { target: compose.target, text } : undefined);
    }
    this.options.tui.requestRender();
  }

  /** Message mode owns the keyboard except for body scrolling. */
  private composeInput(data: string): boolean {
    const compose = this.compose;
    if (!compose) return false;
    // Buffer raw paste privately until its terminator arrives. In particular an
    // ESC, Enter or navigation key inside a paste is data, never a pane action.
    if (compose.paste !== undefined) {
      const buffered = compose.paste + data;
      const end = buffered.indexOf(PASTE_END);
      if (end < 0) {
        // A terminal or multiplexer that drops the terminator must not keep
        // the keyboard: a late chunk is ordinary input again, after what was
        // buffered is inserted as the paste it began as.
        if (performance.now() > compose.pasteDeadline) {
          const pasted = compose.paste;
          compose.paste = undefined;
          if (pasted) this.editCompose(compose, pasted, true);
          if (this.compose === compose) this.handleInput(data);
          return true;
        }
        if (buffered.length > PASTE_BUFFER_UNITS) {
          compose.paste = undefined;
          this.editCompose(compose, buffered, true);
          return true;
        }
        compose.paste = buffered;
        return true;
      }
      compose.paste = undefined;
      this.editCompose(compose, buffered.slice(0, end), true);
      const remaining = buffered.slice(end + PASTE_END.length);
      if (remaining) this.handleInput(remaining);
      return true;
    }
    const held = compose.pastePrefix;
    compose.pastePrefix = [];
    if (held.length) {
      const joined = held.join("") + data;
      if (!joined.startsWith(PASTE_START) && !PASTE_START.startsWith(joined)) {
        // The held chunks were keys of their own (Alt+[ is ESC [), not a split
        // marker: replay each one, then this input, in arrival order.
        for (const chunk of held) {
          this.editCompose(compose, chunk);
          if (this.compose !== compose) return true;
        }
        return this.composeInput(data);
      }
      if (!joined.startsWith(PASTE_START)) {
        compose.pastePrefix = [...held, data];
        return true;
      }
      data = joined;
    }
    const start = data.indexOf(PASTE_START);
    if (start >= 0) {
      if (start) this.composeInput(data.slice(0, start));
      if (this.compose !== compose) return true;
      compose.paste = "";
      compose.pasteDeadline = performance.now() + PASTE_SETTLE_MS;
      return this.composeInput(data.slice(start + PASTE_START.length));
    }
    // The host frames standalone Escape as cancel, not a partial paste marker.
    // Longer start-marker prefixes can safely span input calls.
    for (let length = PASTE_START.length - 1; length >= 2; length--) {
      if (!data.endsWith(PASTE_START.slice(0, length))) continue;
      const before = data.slice(0, -length);
      if (before) this.composeInput(before);
      if (this.compose === compose) compose.pastePrefix = [data.slice(-length)];
      return true;
    }
    if (matchesKey(data, "escape")) {
      // Discards the draft only; a second Esc closes the pane.
      this.endCompose();
      this.options.tui.requestRender();
      return true;
    }
    if (
      (["up", "down", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key)) &&
      this.painted !== 0
    )
      return false;
    const printable = decodeKittyPrintable(data);
    if (printable !== undefined && composeText(printable) !== printable)
      this.editCompose(compose, printable, true);
    else if (!/\p{Cc}/u.test(data) && composeText(data) !== data)
      this.editCompose(compose, data, true);
    else this.editCompose(compose, data);
    return true;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.textSelection.reset();
    if (this.options.visible?.() === false) {
      this.actionsMenu = undefined;
      this.menuPaint = undefined;
      this.chromePaint = undefined;
      this.resetStopInteraction();
      return;
    }
    const compose = this.compose;
    if (
      compose &&
      (compose.paste !== undefined ||
        compose.pastePrefix.length > 0 ||
        data.includes(PASTE_START) ||
        (data.length >= 2 && PASTE_START.startsWith(data)))
    ) {
      // A pointer can arm Stop between chunks of an unfinished paste. Retire
      // that intent before buffering any more bytes: pasted Ctrl+S/Esc/Enter
      // remain private data, never confirmation or a pane command.
      this.resetStopInteraction();
      this.composeInput(data);
      return;
    }
    // Stop confirmation remains deliberate even with a draft open. Ordinary
    // typing cancels the armed intent, never interpreting S or Enter as Stop.
    if (this.compose && this.confirmation) {
      this.retireStopPaint();
      if (matchesKey(data, "ctrl+s")) {
        this.confirmStop();
        return;
      }
      if (matchesKey(data, "escape")) {
        this.resetStopInteraction();
        this.options.tui.requestRender();
        return;
      }
      this.resetStopInteraction();
      // Enter cancels Stop intent only. In a short viewport confirmation may
      // temporarily occupy the draft's footer, so never submit unseen text.
      if (matchesKey(data, "enter")) {
        this.options.tui.requestRender();
        return;
      }
    }
    if (this.composeInput(data)) return;
    // Escape dismisses the layer still visible to the user, even if its
    // geometry or confirmation lifetime expired before the next repaint.
    // Retiring its command evidence first would accidentally close the pane.
    if (matchesKey(data, "escape")) {
      if (this.actionsMenu) {
        this.dismissMenu();
        return;
      }
      if (this.confirmation) {
        this.resetStopInteraction();
        this.options.tui.requestRender();
        return;
      }
    }
    this.retireStopPaint();
    if (this.actionsMenu) {
      if ((["up", "down", "tab"] as const).some((key) => matchesKey(data, key))) {
        this.actionsMenu.selected = this.actionsMenu.selected === 0 ? 1 : 0;
        this.chromePaint = undefined;
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, "enter")) {
        const kind =
          this.actionsMenu.selected === 0 ? (this.info ? "transcript" : "info") : "tools";
        const hit = this.chromePaint?.hits.find((item) => item.kind === kind);
        if (hit) this.activateChrome(hit);
        return;
      }
    }
    if (!this.compose && matchesKey(data, ".")) {
      this.toggleMenu();
      return;
    }
    if (matchesKey(data, "i") || matchesKey(data, "shift+i")) {
      this.toggleInfo();
      return;
    }
    if (
      matchesKey(data, "t") ||
      matchesKey(data, "shift+t") ||
      this.options.expandToolsKey?.(data)
    ) {
      this.toggleTools();
      return;
    }
    if (!this.compose && (matchesKey(data, "m") || matchesKey(data, "shift+m"))) {
      this.requestCompose();
      return;
    }
    if (matchesKey(data, "ctrl+s")) {
      this.confirmStop();
      return;
    }
    if (matchesKey(data, "s") || matchesKey(data, "shift+s")) {
      if (!this.confirmation) this.requestStop();
      return;
    }
    // Pi's focused-input dispatcher requests an immediate render on return.
    // The 120 ms timer animates live activity; it does not gate keyboard paints.
    if (matchesKey(data, "escape")) {
      // The Info page is a layer over the transcript: Esc returns to it first.
      if (this.info) {
        this.toggleInfo();
        return;
      }
      this.closed = true;
      this.resetStopInteraction();
      this.resetCloseHover();
      this.options.done();
      return;
    }
    const { entries, index } = this.current();
    if (matchesKey(data, "left") || matchesKey(data, "h")) return this.select(entries, index - 1);
    if (matchesKey(data, "right") || matchesKey(data, "l") || matchesKey(data, "tab"))
      return this.select(entries, index + 1);

    // Nothing has been laid out yet, so there is no geometry to scroll against.
    // Acting on `painted === 0` would read maxScroll as 0 and mistake every key
    // for "already at the end", silently turning the follow back on.
    if (this.painted === 0) return;
    const { viewportHeight, maxScroll } = this.bounds(this.painted);
    // Deliberate reading/navigation ends a pending cancellation decision;
    // background transcript growth does not. Home/End explicitly set follow.
    if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.followTail = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.followTail = true;
    } else {
      // A minimal title/status/footer paint has no body to scroll. Preserve
      // both a held position and tail-following until there are visible rows.
      if (viewportHeight === 0) return;
      if (matchesKey(data, "up") || matchesKey(data, "k"))
        this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      else if (matchesKey(data, "down") || matchesKey(data, "j"))
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up"))
        this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down"))
        this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      else return;
      this.followTail = this.scrollOffset >= maxScroll;
    }
    // All body-scroll aliases share the same dismissal; unmodified Up/Down
    // were consumed above when the menu owns selection.
    this.dismissMenu();
    this.resetStopInteraction();
    this.options.tui.requestRender();
  }

  /**
   * Wheel over the pane. The alternate-screen renderer offers every wheel event
   * to the overlay under the pointer before it reaches the conversation, and a
   * handled result stops it there, so the page behind never scrolls along.
   * `wheelDelta` is already in logical lines and already carries the terminal's
   * own step -- Alt multiplies it by five upstream -- so it is used as given.
   */
  handleMouse(event: PaneMouseEvent): { handled: boolean } | undefined {
    const close = this.closeHover.mouse(
      event,
      !this.closed &&
        !!this.options.frame &&
        this.paintedWidth > 0 &&
        this.options.visible?.() !== false,
    );
    if (close?.handled) {
      if (close.close) {
        this.closed = true;
        this.resetStopInteraction();
        this.endCompose();
        this.resetCloseHover();
        this.options.done();
      }
      return { handled: true };
    }
    if (this.closed) return undefined;
    if (this.options.visible?.() === false) {
      this.actionsMenu = undefined;
      this.menuPaint = undefined;
      this.chromePaint = undefined;
      this.resetStopInteraction();
      return undefined;
    }
    this.retireStopPaint();
    if (event.type === "press") this.menuDismissPress = false;
    if (event.type === "click" && this.menuDismissPress) {
      this.menuDismissPress = false;
      return { handled: true };
    }
    const chrome = this.chromePaint;
    if (this.actionsMenu && event.type === "wheel") this.dismissMenu();
    if (
      (event.type === "press" || event.type === "click") &&
      event.button === "left" &&
      event.x !== undefined &&
      event.y !== undefined &&
      chrome
    ) {
      const hit = chrome.hits.find(
        (item) => item.y === event.y && event.x! >= item.from && event.x! < item.to,
      );
      if (hit) {
        // Claim the press as well: an unclaimed press starts SDK text
        // selection, whose third rapid gesture selects the whole chrome line
        // and swallows the click. Claiming keeps counting with the SDK's
        // component/position counter; only the released click activates, so a
        // drag away or a stale paint never triggers the transition.
        if (this.actionsMenu && !["menu", "info", "transcript", "tools"].includes(hit.kind)) {
          this.menuDismissPress = event.type === "press";
          this.dismissMenu();
          return { handled: true };
        }
        if (event.type === "click") this.activateChrome(hit);
        return { handled: true };
      }
    }
    if (this.actionsMenu && (event.type === "press" || event.type === "click")) {
      // Claim the resulting click as well as this press, so closing a menu
      // cannot also activate a newly exposed Stop, tab or transcript link.
      this.menuDismissPress = event.type === "press";
      this.dismissMenu();
      return { handled: true };
    }
    const message = this.messageAction;
    if (
      (event.type === "press" || event.type === "click") &&
      event.button === "left" &&
      event.y === this.paintedHeight - this.layout.footerFromBottom &&
      event.x !== undefined &&
      message &&
      event.x >= message.from &&
      event.x < message.to
    ) {
      if (event.type === "click" && (event.clickCount ?? 1) === 1) this.requestCompose();
      return { handled: true };
    }
    const action = this.stopPaint?.action;
    if (
      (event.type === "press" || event.type === "click") &&
      event.button === "left" &&
      event.y === this.paintedHeight - this.layout.footerFromBottom &&
      event.x !== undefined &&
      action &&
      event.x >= action.from &&
      event.x < action.to
    ) {
      // Claim button presses so the SDK counts clicks by component/position,
      // not by text-selection words that change when the label is repainted.
      // Presses and subsequent clicks in one multi-click gesture never confirm.
      if (event.type === "click" && (event.clickCount ?? 1) === 1) {
        if (this.confirmation) this.confirmStop();
        else this.requestStop();
      }
      return { handled: true };
    }
    if (event.type !== "wheel" || !event.wheelDelta || this.painted === 0) return undefined;
    this.textSelection.reset();
    this.resetStopInteraction();
    const { viewportHeight, maxScroll } = this.bounds(this.painted);
    if (viewportHeight === 0) return { handled: true };
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + event.wheelDelta));
    // Same rule as the keys: reaching the end resumes following the live tail.
    this.followTail = this.scrollOffset >= maxScroll;
    this.options.tui.requestRender();
    return { handled: true };
  }

  render(width: number): string[] {
    this.retireStopPaint(width);
    this.stopPaint = undefined;
    this.composePaint = undefined;
    this.messageAction = undefined;
    this.menuPaint = undefined;
    this.chromePaint = undefined;
    this.paintedHeight = 0;
    this.fixedHeight = 0;
    this.composeRows = 0;
    this.bodyFloor = MIN_VIEWPORT;
    this.hiddenNotes = 0;
    this.animating = false;
    const inner = this.options.frame ? width - 2 : width;
    const chrome = this.options.frame ? inner - 4 : inner;
    if (
      this.closed ||
      this.options.visible?.() === false ||
      !Number.isFinite(width) ||
      width < 12 ||
      inner < 10 ||
      chrome < 8 ||
      (Number.isFinite(this.options.tui.terminal.rows) &&
        this.heightBudget() < this.layout.rows + 1)
    ) {
      this.resetCloseHover(false);
      this.resetStopInteraction();
      this.painted = 0;
      return [];
    }
    const gutter = this.options.frame ? 1 : 0;
    const contentWidth = inner - gutter * 2;
    // Framed, the title shares the top edge with the close control.
    const titleWidth = this.options.frame ? popoverInlayWidth(width, "top", true) : chrome;
    this.paintedWidth = this.options.frame ? width : 0;
    const { entries, index } = this.current();
    const entry = entries[index];
    this.renderedRevision = this.options.revision?.();
    this.animating = false;
    if (!entry) {
      this.resetStopInteraction();
      this.painted = 0; // No visible body for keys/wheel to scroll against.
      this.paintedHeight = this.layout.rows + 1;
      return this.dress(
        this.options.theme.fg("dim", "Agents"),
        [
          truncateToWidth(
            this.options.theme.fg("dim", "No agents are available to inspect."),
            contentWidth,
          ),
        ],
        this.footer(chrome, [], 0, undefined, false, false, false),
        width,
        inner,
        gutter,
      );
    }
    const view = entry.input.view;
    this.animating =
      view.status === "queued" || view.status === "running" || view.status === "cancelling";
    if (this.confirmation && !sameStop(this.confirmation.target, view, this.selected))
      this.resetStopInteraction();
    const { owner_id, generation, agent_id, run_id } = view;
    const target = this.confirmation?.target ?? { owner_id, generation, agent_id, run_id };
    // A single bottom metrics row stays separate from the scroll coordinates.
    // Diagnostics may add bounded rows, but routine activity stays in the
    // transcript/Info rather than duplicating a preview beside the reader.
    const th = this.options.theme;
    const recent = this.recentSteer;
    if (
      recent &&
      (!sameRun(recent.target, view) || !steerable(view) || performance.now() >= recent.expiresAt)
    )
      this.recentSteer = undefined;
    // One admission row. The Owner records `human_steered` synchronously on
    // admission, so a fresh acceptance -- the first or any later one -- takes
    // over that row for its lifetime instead of adding a second row.
    const collected = getDetailAttentionNotes(entry.input);
    const notes: readonly DetailAttentionNote[] = this.recentSteer
      ? [
          ...collected.filter((note) => note.key !== "human-steer"),
          {
            key: "recent-steer",
            priority: 12,
            glyph: "✓",
            color: "dim",
            severity: "info",
            text: "Steer accepted · delivery unconfirmed",
          },
        ]
      : collected;
    const noteCount = notes.length;
    const budget = this.heightBudget();
    // Form depends on terminal space, never transcript length or arriving notes.
    // Reserve three dashboard rows before admitting a two-row composer tray.
    const trayRoom =
      !!this.options.onSteer &&
      (steerable(view) || !!this.compose) &&
      budget >= this.layout.rows + MIN_VIEWPORT + COMPOSE_ROWS + 3;
    // Lifecycle state has no title/tab fallback for a lone Agent. Reserve its
    // bottom row before the preferred three body rows, even at tiny heights.
    this.bodyFloor =
      Math.min(MIN_VIEWPORT, Math.max(0, budget - this.layout.rows - 1)) +
      (trayRoom ? COMPOSE_ROWS : 0);
    const capacity = Math.max(1, budget - this.layout.rows - this.bodyFloor);
    // The Info return link is page-local, not a permanent toolbar. Short panes
    // retain I/Esc even if they cannot allocate its row.
    const back =
      this.info && capacity >= 3 && contentWidth >= visibleWidth("← Transcript")
        ? [th.fg("accent", "← Transcript")]
        : [];
    const available = capacity - back.length;
    const ruleRows = available > 1 ? 1 : 0;
    const noticeRows = Math.min(2, Math.max(0, available - 1 - ruleRows), noteCount);
    const notices = renderDetailAttention(entry.input, th, contentWidth, {
      maxRows: noticeRows,
      notes,
      info: this.info,
    });
    const summary = renderDetailSummary(entry.input, th, contentWidth, {
      activity: false,
      spinnerFrame: this.frame,
    });
    // Menu overflow and the footer's no-pinned-row fallback are different
    // facts: partial overflow belongs on Info, not an extra footer !N.
    const overflowNotes = Math.max(0, noteCount - noticeRows);
    this.hiddenNotes = noticeRows === 0 ? noteCount : 0;
    // No text or controls ride this separator. It separates reading from the
    // one-line observation dock, with the same inset as the transcript body.
    const fixed = [
      ...notices,
      ...(ruleRows ? [th.fg("borderMuted", "─".repeat(contentWidth))] : []),
      ...summary,
    ];
    this.fixedHeight = back.length + fixed.length;
    const source = this.info ? undefined : this.options.transcript(entry.agent_id);
    source?.setToolsExpanded?.(this.toolsExpanded);
    const info = this.info
      ? renderDetailInfo(entry.input, th, contentWidth, (text, width) => this.wrapInfo(text, width))
      : undefined;
    const rows: TranscriptFrame | undefined = info
      ? { lineCount: info.length, slice: (start, count) => info.slice(start, start + count) }
      : (source?.frame?.(contentWidth) ??
        (source
          ? {
              lineCount: source.lineCount(contentWidth),
              slice: (start, count) => source.slice(contentWidth, start, count),
            }
          : undefined));
    const total = Math.max(1, rows?.lineCount ?? 0);
    this.painted = total;
    this.composeRows = this.compose && trayRoom ? COMPOSE_ROWS : 0;
    if (!this.info && this.pendingToolAnchor) {
      const pending = this.pendingToolAnchor;
      if (
        source === pending.source &&
        contentWidth === pending.width &&
        sameRun(pending.target, view)
      ) {
        const restored = rows?.resolveAnchor?.(pending.anchor);
        if (restored !== undefined) this.scrollOffset = restored;
      }
      this.pendingToolAnchor = undefined;
    }
    const { viewportHeight, maxScroll, fits } = this.bounds(total);
    // A live transcript grows under the reader; only follow when they are at the end.
    // Clamped, not merely read: a body that SHRANK -- compaction, a resize, an
    // Agent with a shorter transcript -- would otherwise leave the offset above
    // the new maximum, and the next key up would still be `>= maxScroll` and so
    // re-engage following instead of scrolling.
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
    if (this.followTail) this.scrollOffset = maxScroll;
    const inputAvailable =
      fits &&
      Number.isFinite(this.options.tui.terminal.columns) &&
      width <= this.options.tui.terminal.columns;
    const canCompose =
      !this.compose &&
      !this.confirmation &&
      !!this.options.onSteer &&
      steerable(view) &&
      inputAvailable;
    const start = this.scrollOffset;
    if (!this.info) {
      const anchor = !this.followTail ? rows?.anchorAt?.(start) : undefined;
      this.transcriptRead =
        source && anchor !== undefined
          ? {
              source,
              width: contentWidth,
              target: { owner_id, generation, agent_id, run_id },
              anchor,
            }
          : undefined;
    }
    const compose = this.compose;
    const footer: DetailFooterFrame =
      compose && this.composeRows === 0 && !this.confirmation
        ? {
            text: renderComposeFooter({
              width: chrome,
              input: (room) => compose.input.render(room)[0] ?? "",
              sendable: sameRun(compose.target, view) && steerable(view),
              empty: compose.empty,
              tooLong: overLimit(compose),
              hiddenNotes: this.hiddenNotes,
              unavailable: inputAvailable ? undefined : "geometry",
              theme: this.options.theme,
            }),
          }
        : this.footer(
            chrome,
            entries,
            Math.max(0, total - (start + viewportHeight)),
            view,
            fits &&
              Number.isFinite(this.options.tui.terminal.columns) &&
              width <= this.options.tui.terminal.columns &&
              !!this.options.onStop &&
              stoppable(view),
            !!this.confirmation,
            canCompose,
          );
    this.paintedHeight = this.fixedHeight + viewportHeight + this.composeRows + this.layout.rows;
    const dimensions = {
      columns: this.options.tui.terminal.columns,
      rows: this.options.tui.terminal.rows,
      width,
    };
    // Geometry is published once per paint; formatting never admits input.
    if (footer.action)
      this.stopPaint = {
        target,
        action: footer.action,
        dimensions,
      };
    else this.resetStopInteraction();
    if (canCompose)
      this.composePaint = {
        target: { owner_id, generation, agent_id, run_id },
        dimensions,
      };
    this.messageAction = this.composePaint ? footer.messageAction : undefined;
    if (fits && Number.isFinite(dimensions.columns) && width <= dimensions.columns) {
      // Control columns are body cells: past the frame's side and the gutter.
      const edge = this.paintedHeight - this.layout.footerFromBottom;
      const contentX = (this.options.frame ? 1 : 0) + gutter;
      const hits: ChromeHit[] = [
        ...(footer.tabs ?? []).map((tab) => ({ kind: "agent" as const, y: edge, ...tab })),
        ...(footer.tail ? [{ kind: "tail" as const, y: edge, ...footer.tail }] : []),
        ...(footer.menu ? [{ kind: "menu" as const, y: edge, ...footer.menu }] : []),
        ...(back.length
          ? [
              {
                kind: "transcript" as const,
                y: this.layout.bodyY,
                from: contentX,
                to: contentX + visibleWidth("← Transcript"),
              },
            ]
          : []),
      ];
      if (hits.length) this.chromePaint = { dimensions, hits };
      if (footer.menu && !this.compose && !this.confirmation)
        this.menuPaint = { target: { owner_id, generation, agent_id, run_id }, dimensions };
    }
    const window = this.window(rows, contentWidth, start, viewportHeight);
    const menuState = this.actionsMenu;
    if (menuState && (!sameRun(menuState.target, view) || !inputAvailable)) this.dismissMenu();
    if (this.actionsMenu) {
      const menu = renderDetailActionsMenu({
        width: contentWidth,
        height: viewportHeight,
        info: this.info,
        toolsExpanded: this.toolsExpanded,
        hiddenNotes: overflowNotes,
        selected: this.actionsMenu.selected,
        theme: th,
      });
      if (menu && this.chromePaint) {
        const offset = viewportHeight - menu.rows.length;
        for (const [index, row] of menu.rows.entries()) {
          const underneath = window[offset + index] ?? "";
          // A sliced prefix may still own SGR or OSC 8 state. The public SDK
          // compositor closes both segment boundaries, including before the
          // pane's right gutter/frame, while preserving left-hand styling.
          window[offset + index] = compositeTuiLine(
            underneath,
            sliceByColumn(row, menu.from, contentWidth - menu.from, true),
            menu.from,
            contentWidth - menu.from,
            contentWidth,
          );
        }
        const contentX = (this.options.frame ? 1 : 0) + gutter;
        this.chromePaint.hits = [
          ...this.chromePaint.hits.filter((hit) => hit.kind === "menu"),
          ...menu.items.map((item) => ({
            kind: item.kind,
            y: this.layout.bodyY + back.length + offset + item.y,
            from: contentX + item.from,
            to: contentX + item.to,
          })),
        ];
      } else {
        this.dismissMenu();
      }
    }
    const body = [...back, ...window, ...fixed];
    if (compose && this.composeRows) {
      body.push(
        renderDetailComposeHeading({
          width: contentWidth,
          name: sameRun(compose.target, view) ? view.name || "Agent" : "original task",
          task: sameRun(compose.target, view) ? view.task : undefined,
          sendable: sameRun(compose.target, view) && steerable(view),
          empty: compose.empty,
          tooLong: overLimit(compose),
          theme: th,
        }),
        compose.input.render(contentWidth)[0] ?? "",
      );
    }
    return this.dress(
      renderDetailTitle(entry.input, this.options.theme, titleWidth),
      body,
      footer,
      width,
      inner,
      gutter,
      {
        from: back.length,
        height: viewportHeight,
        offset: start,
        total,
        key: JSON.stringify([
          owner_id,
          generation,
          agent_id,
          run_id,
          this.info,
          this.toolsExpanded,
          start,
        ]),
      },
    );
  }

  invalidate(): void {
    this.resetCloseHover();
    this.resetStopInteraction();
    this.wrapped.clear();
    this.transcriptRead = undefined;
    this.pendingToolAnchor = undefined;
    this.options.invalidate?.();
  }
  dispose(): void {
    this.closed = true;
    this.unwatchBorderLabels();
    this.closeHover.dispose();
    this.textSelection.dispose();
    this.resetStopInteraction();
    clearInterval(this.timer);
    this.chromePaint = undefined;
    this.wrapped.clear();
    this.transcriptRead = undefined;
    this.pendingToolAnchor = undefined;
  }

  // ---- Private ----

  private wrapInfo(text: string, width: number): string[] {
    const cached = this.wrapped.get(text);
    this.wrapped.delete(text);
    const rows = cached?.width === width ? cached.rows : wrapText(text, width);
    if (text.length <= 16_384) {
      this.wrapped.set(text, { width, rows });
      if (this.wrapped.size > 64) this.wrapped.delete(this.wrapped.keys().next().value!);
    }
    return rows;
  }

  /** A chrome click: the same transitions as the keys that the chrome names. */
  private activateChrome(hit: ChromeHit): void {
    if (hit.kind === "menu") return this.toggleMenu();
    if (hit.kind === "agent") {
      const { entries } = this.current();
      if (
        hit.agent_id !== this.selected &&
        entries.some((entry) => entry.agent_id === hit.agent_id)
      )
        this.adopt(hit.agent_id);
      this.options.tui.requestRender();
      return;
    }
    if (hit.kind === "tools") return this.toggleTools();
    if (hit.kind === "transcript" || hit.kind === "info") {
      if ((hit.kind === "info") !== this.info) this.toggleInfo();
      return;
    }
    // `↓ N more` is End: back to the tail, following it again.
    if (this.painted === 0) return;
    this.scrollOffset = this.bounds(this.painted).maxScroll;
    this.followTail = true;
    this.resetStopInteraction();
    this.options.tui.requestRender();
  }

  private toggleTools(): void {
    this.actionsMenu = undefined;
    this.menuPaint = undefined;
    const following = this.info ? (this.transcriptPosition?.follow ?? true) : this.followTail;
    this.pendingToolAnchor = following ? undefined : this.transcriptRead;
    this.toolsExpanded = !this.toolsExpanded;
    this.resetStopInteraction();
    this.chromePaint = undefined;
    this.painted = 0;
    this.options.tui.requestRender();
  }

  private toggleInfo(): void {
    this.actionsMenu = undefined;
    this.menuPaint = undefined;
    if (!this.info) {
      this.transcriptPosition = { offset: this.scrollOffset, follow: this.followTail };
      this.scrollOffset = 0;
      this.followTail = false;
    } else {
      this.scrollOffset = this.transcriptPosition?.offset ?? 0;
      this.followTail = this.transcriptPosition?.follow ?? true;
      this.transcriptPosition = undefined;
    }
    this.info = !this.info;
    this.painted = 0;
    this.chromePaint = undefined;
    this.resetStopInteraction();
    this.options.tui.requestRender();
  }

  private dismissMenu(): void {
    if (!this.actionsMenu) return;
    this.textSelection.reset();
    this.actionsMenu = undefined;
    this.chromePaint = undefined;
    this.options.tui.requestRender();
  }

  private toggleMenu(): void {
    if (this.actionsMenu) return this.dismissMenu();
    const paint = this.menuPaint;
    if (!paint || this.compose || this.confirmation) return;
    const view = (this.options.freshSnapshot ?? this.options.snapshot)().find(
      (entry) => entry.agent_id === this.selected,
    )?.input.view;
    if (this.geometryChanged(paint.dimensions) || !sameRun(paint.target, view)) return;
    this.resetStopInteraction();
    this.textSelection.reset();
    this.actionsMenu = { ...paint, selected: 0 };
    this.chromePaint = undefined;
    this.options.tui.requestRender();
  }

  /** Only the active page scrolls; pinned observations are separate rows. */
  private window(
    rows: TranscriptFrame | undefined,
    width: number,
    start: number,
    height: number,
  ): string[] {
    const out = (
      rows?.slice(start, height) ?? [this.options.theme.fg("dim", "No transcript available.")]
    )
      .slice(0, height)
      .map((row) => truncateToWidth(row, width));
    while (out.length < height) out.push("");
    return out;
  }

  /** Chrome around the body. Bands share one layout for their row budget and
   * hit coordinates; inset labels keep the outer frame and scrollbar. */
  private dress(
    title: string,
    body: string[],
    footer: Pick<DetailFooterFrame, "text" | "flush">,
    width: number,
    inner: number,
    gutter = 0,
    scroll?: { from: number; height: number; offset: number; total: number; key?: string },
  ): string[] {
    this.textSelection.paint(
      this.options.frame && !this.actionsMenu
        ? popoverTextRect(width, body.length + this.layout.rows, {
            inset: 1 + gutter,
            ...(scroll
              ? {
                  top: this.layout.bodyY + scroll.from,
                  bottom: this.layout.bottom.rows + body.length - scroll.from - scroll.height,
                }
              : {}),
          })
        : undefined,
      scroll?.key,
    );
    this.closeHover.paint(
      width,
      !!this.options.frame && this.options.visible?.() !== false,
      body.length + this.layout.rows,
    );
    if (!this.options.frame)
      return [title, ...body, footer.text].map((line) => truncateToWidth(line, width));
    const th = this.options.theme;
    const side = popoverSide(th);
    const top = popoverLabelRows(th, width, title, "top", true, this.closeHover.hovered);
    // Keep the reserved band when narrow-width labels yield completely:
    // content changes must not move the viewport or rebase painted controls.
    const bottom =
      footer.text || this.layout.bottom.placement === "inside"
        ? popoverLabelRows(th, width, footer.text, "bottom", false, false, footer.flush)
        : [popoverBottom(th, width)];
    return [
      ...top,
      ...body.map((line, i) => {
        let edge = side;
        if (
          scroll &&
          scroll.total > scroll.height &&
          i >= scroll.from &&
          i < scroll.from + scroll.height
        ) {
          const thumb = Math.max(1, Math.floor((scroll.height * scroll.height) / scroll.total));
          const top = Math.round(
            (scroll.offset / (scroll.total - scroll.height)) * (scroll.height - thumb),
          );
          if (i - scroll.from >= top && i - scroll.from < top + thumb)
            edge = th.fg("borderAccent", "┃");
        }
        return (
          side +
          " ".repeat(gutter) +
          padTo(truncateToWidth(line, inner - gutter * 2), inner - gutter * 2) +
          " ".repeat(gutter) +
          edge
        );
      }),
      ...bottom,
    ];
  }

  /** The one place a row count becomes a viewport, so `render` and `handleInput`
   * cannot disagree about how far the pane scrolls. Content-sized and capped at
   * a share of the terminal, never a fixed reservation of blank rows. */
  private bounds(total: number): { viewportHeight: number; maxScroll: number; fits: boolean } {
    const budget = this.heightBudget();
    const bodyHeight = Math.max(
      this.bodyFloor,
      Math.min(total, Math.max(0, budget - this.layout.rows - this.fixedHeight)),
    );
    const viewportHeight = bodyHeight - this.composeRows;
    return {
      viewportHeight,
      maxScroll: Math.max(0, total - viewportHeight),
      // Keep the existing three-body-row command floor beyond the chrome
      // bands (five total rows in the default border layout). Smaller paints
      // can show title/status/footer, but do not mint input evidence.
      fits:
        budget >= this.layout.rows + MIN_VIEWPORT &&
        bodyHeight + this.fixedHeight + this.layout.rows <= budget,
    };
  }

  private heightBudget(): number {
    const rows = this.options.tui.terminal.rows;
    return Number.isFinite(rows)
      ? Math.max(
          0,
          Math.floor((rows * (this.options.frame ? FLOATING_HEIGHT_PCT : DOCKED_HEIGHT_PCT)) / 100),
        )
      : 0;
  }

  /** Pure chrome layout. Only render publishes its optional painted action. */
  private footer(
    width: number,
    entries: readonly { agent_id: string; input: DetailInput }[],
    below: number,
    view: RunView | undefined,
    available: boolean,
    confirming: boolean,
    messaging: boolean,
  ): DetailFooterFrame {
    return renderDetailFooter({
      width,
      entries,
      selected: this.selected,
      below,
      // Only a live Run's transcript keeps growing under the reader.
      live: !this.info && this.animating,
      view,
      available,
      confirming,
      messaging,
      composing: !!this.compose,
      menu:
        !!view &&
        !this.compose &&
        !confirming &&
        width >= (this.options.frame ? 14 : 16) &&
        this.bounds(this.painted).fits &&
        this.bounds(this.painted).viewportHeight >= 2 &&
        Number.isFinite(this.options.tui.terminal.columns) &&
        width <= this.options.tui.terminal.columns - (this.options.frame ? 6 : 0),
      hiddenNotes: this.hiddenNotes,
      spinnerFrame: this.frame,
      theme: this.options.theme,
      framed: !!this.options.frame,
      borderLabels: this.layout.bottom.placement === "border",
    });
  }
}
