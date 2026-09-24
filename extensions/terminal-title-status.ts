import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE_WIDTH = 12;
const TITLE_WIDGET_KEY = "terminal-title-controller";
const WORK_INTERVAL_MS = 33;
const WORK_PAUSE_MS = 1_980;

type AnimatedState = "working";

const SINGLE_UNDERLINE = "\u0332";
const DOUBLE_UNDERLINE = "\u0333";

function requestIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) {
    return undefined;
  }
  const requestId = value.requestId;
  return typeof requestId === "string" && requestId ? requestId : undefined;
}

function compactTitle(value: string, width = TITLE_WIDTH): string {
  const clean = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(clean || "pi");
  return characters.length <= width
    ? characters.join("")
    : `${characters.slice(0, width - 1).join("")}…`;
}

function underlineCharacter(character: string, double: boolean): string {
  return /\s/.test(character)
    ? character
    : `${character}${double ? DOUBLE_UNDERLINE : SINGLE_UNDERLINE}`;
}

function spotlightTitle(title: string, frameIndex: number): string {
  const characters = Array.from(title);
  const firstCenter = -2;
  const lastCenter = characters.length + 1;
  const motionFrames = (lastCenter - firstCenter) * 2 + 1;
  const pauseFrames = Math.round(WORK_PAUSE_MS / WORK_INTERVAL_MS);
  const cycleFrame = frameIndex % (motionFrames + pauseFrames);

  // Let the highlight leave the title completely before the next sweep.
  if (cycleFrame >= motionFrames) return title;

  // Half-cell frames contract the three-character highlight to two characters,
  // creating a simple temporal cross-fade without changing glyph widths.
  const center = firstCenter + cycleFrame / 2;
  const radius = Number.isInteger(center) ? 1 : 0.5;
  return characters
    .map((character, index) => {
      const distance = Math.abs(index - center);
      if (distance === 0) return underlineCharacter(character, true);
      if (distance <= radius) return underlineCharacter(character, false);
      return character;
    })
    .join("");
}

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let running = false;
  let animatedState: AnimatedState | undefined;
  let frameIndex = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTitle: string | undefined;
  const pendingPermissionRequests = new Set<string>();

  function rawLabel(): string {
    return pi.getSessionName()?.trim() || basename(context?.cwd ?? process.cwd());
  }

  function label(width = TITLE_WIDTH): string {
    return compactTitle(rawLabel(), width);
  }

  function currentState(): AnimatedState | "approval" | "idle" {
    if (pendingPermissionRequests.size > 0) return "approval";
    return running ? "working" : "idle";
  }

  function currentTitle(): string {
    const state = currentState();
    let title: string;
    if (state === "working") {
      title = spotlightTitle(label(), frameIndex);
    } else if (state === "approval") {
      return `! - ${label()}`;
    } else {
      title = label();
    }

    // Keep the application prefix stable while the task label animates.
    return `π - ${title}`;
  }

  function setTitle(): void {
    if (!context || context.mode !== "tui") return;

    const title = currentTitle();
    if (title === lastTitle) return;
    context.ui.setTitle(title);
    lastTitle = title;
  }

  function stopAnimation(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    animatedState = undefined;
    frameIndex = 0;
  }

  function syncTitle(): void {
    if (!context || context.mode !== "tui") {
      stopAnimation();
      return;
    }

    const state = currentState();
    const nextAnimatedState = state === "working" ? state : undefined;

    if (nextAnimatedState !== animatedState) {
      stopAnimation();
      animatedState = nextAnimatedState;
      setTitle();

      if (nextAnimatedState) {
        timer = setInterval(() => {
          frameIndex += 1;
          setTitle();
        }, WORK_INTERVAL_MS);
      }
      return;
    }

    setTitle();
  }

  const unsubscribePermissionPrompt = pi.events.on(
    "permissions:ui_prompt",
    (value) => {
      const requestId = requestIdFrom(value);
      if (!requestId) return;
      pendingPermissionRequests.add(requestId);
      syncTitle();
    },
  );

  // A failed/expired dialog may never receive a decision with its original ID:
  // upstream's fail-closed boundary mints a new one. Observe UI settlement too,
  // without inventing a verdict or clearing other (possibly worker) asks.
  const unsubscribePermissionEnds = ["permissions:decision", "managed-permissions:ui_prompt_end:v1"]
    .map((channel) => pi.events.on(channel, (value) => {
      const requestId = requestIdFrom(value);
      if (!requestId || !pendingPermissionRequests.delete(requestId)) return;
      syncTitle();
    }));

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    running = false;
    lastTitle = undefined;
    pendingPermissionRequests.clear();
    if (ctx.mode === "tui") {
      // Core rewrites the title after session_start (and before rename hooks).
      // Own the terminal setter for this session so those writes use the same
      // prefix/animation instead of racing a deferred startup title update.
      ctx.ui.setWidget(TITLE_WIDGET_KEY, (tui) => {
        const terminal = tui.terminal;
        const originalSetTitle = terminal.setTitle;
        const setManagedTitle = (_title: string) => {
          const title = currentTitle();
          originalSetTitle.call(terminal, title);
          lastTitle = title;
        };
        terminal.setTitle = setManagedTitle;
        return {
          render: () => [],
          invalidate() {},
          dispose() {
            if (terminal.setTitle === setManagedTitle) terminal.setTitle = originalSetTitle;
          },
        };
      });
    }
    syncTitle();
  });

  pi.on("session_info_changed", (_event, ctx) => {
    context = ctx;
    setTitle();
  });

  pi.on("agent_start", (_event, ctx) => {
    context = ctx;
    running = true;
    syncTitle();
  });

  pi.on("agent_settled", (_event, ctx) => {
    context = ctx;
    running = false;
    syncTitle();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation();
    pendingPermissionRequests.clear();
    running = false;
    if (ctx.mode === "tui") {
      ctx.ui.setTitle(`π - ${label()}`);
      ctx.ui.setWidget(TITLE_WIDGET_KEY, undefined);
    }
    lastTitle = undefined;
    context = undefined;
    unsubscribePermissionPrompt();
    for (const unsubscribe of unsubscribePermissionEnds) unsubscribe();
  });
}
