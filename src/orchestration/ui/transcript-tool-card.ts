/**
 * A recorded SDK tool card with a revocable display boundary. Renderers remain
 * trusted extension code: this cannot cancel their timers or revoke component
 * references they retain independently. Only bridge-supplied entry points are
 * guarded. No execution-started / argument-complete previews are enabled.
 */
import { ToolExecutionComponent, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { copyDisplayData } from "../presentation/display-data.ts";
import { detachedToolResult } from "./tool-result-projection.ts";

type RecordedResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type CallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type RenderContext = Parameters<CallRenderer>[2];

interface CardOptions {
  name: string;
  callId: string;
  args: unknown;
  renderers: ToolRenderers;
  tui: TUI;
  cwd: string;
  isCurrent: () => boolean;
  changed: () => void;
}

const RAW_RENDERERS: ToolRenderers = {};
const MARKER = "[unrenderable tool card]";

/** Refuse async display code, observing genuine rejections without probing thenables. */
function synchronous(value: unknown): unknown {
  if (value instanceof Promise) {
    void value.catch(() => {});
    throw new Error("Async tool display is unsupported");
  }
  return value;
}

function lines(value: unknown): readonly string[] {
  const rows = synchronous(value);
  if (!Array.isArray(rows) || !rows.every((row) => typeof row === "string"))
    throw new Error("Invalid tool display rows");
  return rows;
}

/** Owns the SDK component; the pane never invokes an unguarded custom tree. */
export class TranscriptToolCard implements Component {
  private readonly name: string;
  private readonly callId: string;
  private readonly args: unknown;
  private readonly tui: TUI;
  private readonly cwd: string;
  private isCurrent: () => boolean;
  private changed: () => void;
  private readonly originals = new WeakMap<Component, Component>();
  private readonly facades = new WeakMap<Component, Component>();
  private readonly traversing = new Set<Component>();
  private sdk?: ToolExecutionComponent;
  private result?: RecordedResult;
  private expanded = false;
  private retired = false;
  private failed = false;
  private rawBroken = false;
  private fallbackPending = false;
  private epoch = 0;
  private depth = 0;
  private invalidating = false;
  private pendingInvalidate = false;
  private invalidateQueued = false;

  constructor(options: CardOptions) {
    this.name = options.name;
    this.callId = options.callId;
    // Never give this private snapshot to SDK/custom display code. A renderer
    // may mutate its working copy before throwing, or retain it after failure.
    this.args = copyDisplayData(options.args);
    this.tui = options.tui;
    this.cwd = options.cwd;
    this.isCurrent = options.isCurrent;
    this.changed = options.changed;
    this.run(() => {
      this.sdk = this.create(this.wrap(options.renderers));
    });
  }

  render(width: number): readonly string[] {
    if (!Number.isInteger(width) || width <= 0) return [];
    if (!this.current()) return [];
    if (this.depth > 0) return [MARKER];
    const before = this.sdk;
    let rendered: readonly string[] = [MARKER];
    this.run(() => {
      if (this.sdk) rendered = lines(this.sdk.render(width));
    });
    // A lazy component failure replaced the custom card. Paint its raw record
    // at the same width now, rather than losing the message for this frame.
    if (this.sdk && this.sdk !== before)
      this.run(() => {
        rendered = lines(this.sdk!.render(width));
      });
    return this.rawBroken ? [MARKER] : rendered;
  }

  invalidate(): void {
    if (!this.rawBroken) this.run(() => this.sdk?.invalidate());
  }

  /** Keep palette-stable invalidation from rebuilding settled SDK callbacks. */
  invalidateLayout(): void {
    if (this.rawBroken) return;
    this.run(() => {
      if (this.sdk) this.layout(this.sdk, new Set());
    });
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (!this.rawBroken) this.run(() => this.sdk?.setExpanded(expanded));
  }

  updateResult(result: RecordedResult): void {
    if (!this.current()) return;
    this.result = detachedToolResult(result);
    if (this.rawBroken) {
      // New data may make raw rendering possible; never retry custom callbacks.
      this.rawBroken = false;
      this.fallbackPending = true;
      this.finish();
    } else this.run(() => this.sdk?.updateResult(detachedToolResult(this.result!)));
  }

  retire(): void {
    this.retired = true;
    this.epoch++;
    this.pendingInvalidate = false;
    this.sdk = undefined;
    this.result = undefined;
    this.isCurrent = () => false;
    this.changed = () => {};
  }

  private create(renderers: ToolRenderers): ToolExecutionComponent {
    return new ToolExecutionComponent(
      this.name,
      this.callId,
      copyDisplayData(this.args),
      { showImages: false },
      renderers,
      this.tui,
      this.cwd,
    );
  }

  private current(): boolean {
    if (this.retired) return false;
    try {
      return this.isCurrent() === true;
    } catch {
      return false;
    }
  }

  private customCurrent(epoch = this.epoch): boolean {
    return !this.failed && epoch === this.epoch && this.current();
  }

  private wrap(renderers: ToolRenderers): ToolRenderers {
    const wrapped: ToolRenderers = { renderShell: renderers.renderShell };
    const call = renderers.renderCall;
    const result = renderers.renderResult;
    if (call)
      wrapped.renderCall = (_args, theme, context) =>
        this.callback(() => {
          const args = copyDisplayData(this.args);
          return call(args, theme, this.context(context, args));
        });
    if (result)
      wrapped.renderResult = (_data, options, theme, context) =>
        this.callback(() => {
          const args = copyDisplayData(this.args);
          const display = detachedToolResult(this.result ?? { content: [] });
          const data = {
            content: display.content,
            details: display.details as unknown,
          } as Parameters<typeof result>[0];
          return result(data, options, theme, this.context(context, args));
        });
    return wrapped;
  }

  private context(context: RenderContext, args: unknown): RenderContext {
    const epoch = this.epoch;
    return {
      ...context,
      args,
      lastComponent: context.lastComponent
        ? (this.originals.get(context.lastComponent) ?? context.lastComponent)
        : undefined,
      invalidate: () => {
        if (this.customCurrent(epoch)) this.scopedInvalidate();
      },
    };
  }

  private callback(invoke: () => unknown): Component {
    if (!this.customCurrent()) throw new Error("Retired tool renderer");
    try {
      const value = synchronous(invoke());
      if (!value || typeof value !== "object") throw new Error("Invalid tool component");
      return this.component(value as Component);
    } catch (error) {
      this.fail();
      // The SDK supplies its normal fallback during this operation. finish()
      // then replaces the whole failed tree so later updates cannot revive it.
      throw error;
    }
  }

  private component(component: Component): Component {
    synchronous(component);
    if (typeof component.render !== "function" || typeof component.invalidate !== "function")
      throw new Error("Invalid tool component");
    const existing = this.facades.get(component);
    if (existing) return existing;
    const epoch = this.epoch;
    const facade: Component = {
      render: (width) => {
        if (!this.customCurrent(epoch)) return [];
        try {
          return this.withChildren(component, () => lines(component.render(width)));
        } catch (error) {
          this.fail();
          throw error;
        }
      },
      invalidate: () => {
        if (!this.customCurrent(epoch)) return;
        try {
          this.withChildren(component, () => synchronous(component.invalidate()));
        } catch (error) {
          this.fail();
          throw error;
        }
      },
    };
    this.originals.set(facade, component);
    this.facades.set(component, facade);
    return facade;
  }

  /**
   * Container/Box discard child invalidate return values and consume render
   * returns before the outer boundary sees them. Guard their public children
   * during the synchronous call, then restore original component identities.
   * Methods/private fields are never patched. Independently held child refs
   * remain trusted code, outside this traversable public-tree boundary.
   */
  private withChildren<T>(component: Component, operation: () => T): T {
    if (!(component instanceof Container || component instanceof Box)) return operation();
    if (this.traversing.has(component)) throw new Error("Circular tool component tree");
    const descriptor = Object.getOwnPropertyDescriptor(component, "children");
    if (!descriptor?.configurable || !("value" in descriptor))
      throw new Error("Unsupported tool component children");
    let children = component.children;
    const exposed = new WeakMap<Component[], Component[]>();
    const targets = new WeakMap<Component[], Component[]>();
    const unwrap = (child: Component): Component => this.originals.get(child) ?? child;
    const expose = (): Component[] => {
      let proxy = exposed.get(children);
      if (!proxy) {
        proxy = new Proxy(children, {
          get: (target, key, receiver): unknown => {
            // SDK removeChild uses indexOf(originalChild). Preserve identity
            // queries even though indexed traversal receives guarded facades.
            if (key === "indexOf")
              return (child: Component, from?: number) => target.indexOf(unwrap(child), from);
            if (key === "includes")
              return (child: Component, from?: number) => target.includes(unwrap(child), from);
            if (key === "lastIndexOf")
              return (...args: Parameters<Component[]["lastIndexOf"]>) =>
                args.length < 2
                  ? target.lastIndexOf(unwrap(args[0]))
                  : target.lastIndexOf(unwrap(args[0]), args[1]);
            const value: unknown = Reflect.get(target, key, receiver);
            // Guard at access time: addChild(), splice() and replacement of
            // children during render/invalidate must not introduce bare leaves.
            return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && value
              ? this.component(value as Component)
              : value;
          },
          set: (target, key, value: unknown): boolean =>
            Reflect.set(target, key, this.originals.get(value as Component) ?? value),
        });
        exposed.set(children, proxy);
        targets.set(proxy, children);
      }
      return proxy;
    };
    this.traversing.add(component);
    try {
      Object.defineProperty(component, "children", {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: expose,
        set: (value: Component[]) => {
          if (!Array.isArray(value)) throw new Error("Invalid tool component children");
          const raw = targets.get(value) ?? value;
          const originals = raw.map(unwrap);
          children = originals.every((child, i) => child === raw[i]) ? raw : originals;
        },
      });
      return operation();
    } finally {
      this.traversing.delete(component);
      Object.defineProperty(component, "children", { ...descriptor, value: children });
    }
  }

  private layout(component: Component, seen: Set<Component>): void {
    if (!this.current() || seen.has(component)) return;
    seen.add(component);
    const original = this.originals.get(component);
    if (original && !this.customCurrent()) return;
    const target = original ?? component;
    if (original && seen.has(target)) return;
    seen.add(target);
    if (target instanceof Container || target instanceof Box) {
      for (const child of target.children) this.layout(child, seen);
    } else synchronous(target.invalidate());
  }

  private run(operation: () => void): void {
    if (!this.current()) return;
    this.depth++;
    try {
      operation();
    } catch {
      this.fail();
    } finally {
      this.depth--;
    }
    this.finish();
  }

  /** Failure is sticky for the card; old facades and saved handles die immediately. */
  private fail(): void {
    if (this.failed) {
      // Only a failure in the replacement raw tree reaches this branch: stale
      // custom facades already no-op and stale callbacks throw inside the SDK.
      if (!this.fallbackPending) {
        this.rawBroken = true;
        this.sdk = undefined;
      }
      return;
    }
    this.failed = true;
    this.epoch++;
    this.pendingInvalidate = false;
    this.fallbackPending = true;
  }

  private finish(): void {
    if (this.depth > 0 || !this.current()) return;
    if (this.fallbackPending) {
      this.fallbackPending = false;
      try {
        const raw = this.create(RAW_RENDERERS);
        raw.setExpanded(this.expanded);
        if (this.result) raw.updateResult(detachedToolResult(this.result));
        this.sdk = raw;
      } catch {
        this.sdk = undefined;
        this.rawBroken = true;
      }
    }
    if (!this.pendingInvalidate || this.invalidating || this.invalidateQueued) return;
    this.invalidateQueued = true;
    queueMicrotask(() => {
      this.invalidateQueued = false;
      if (this.pendingInvalidate && this.customCurrent()) this.performInvalidate();
    });
  }

  private scopedInvalidate(): void {
    if (this.invalidating) return; // Coalesce callbacks invalidating during this very refresh.
    if (this.depth > 0) {
      this.pendingInvalidate = true;
      return;
    }
    this.performInvalidate();
  }

  private performInvalidate(): void {
    if (!this.customCurrent() || this.invalidating) return;
    this.pendingInvalidate = false;
    this.invalidating = true;
    try {
      this.invalidate();
      if (!this.current()) return;
      this.changed();
      this.tui.requestRender();
    } catch {
      // Cache/wake failure is presentation-only, not an Owner/session fault.
    } finally {
      this.invalidating = false;
    }
  }
}
