import { ModelSelectorComponent, type ModelRuntime, type ScopedModel } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { HarnessError } from "../core/ports.js";

type Model = ReturnType<ModelRuntime["getModels"]>[number];
const views = new WeakMap<ModelRuntime, ModelRuntime>();
const hasScopeSnapshot = (value: unknown): boolean => Array.isArray(value);

/** The host's real runtime, with only the selector's model queries narrowed.
 * Methods stay bound to the host; no second runtime or credential store exists.
 * Native catalog refresh/cancellation is preserved, including its normal I/O. */
function physicalView(runtime: ModelRuntime | undefined): ModelRuntime {
  if (!runtime || typeof runtime.getAvailableSnapshot !== "function" || typeof runtime.getModel !== "function" ||
      typeof runtime.getError !== "function" || typeof runtime.refresh !== "function") {
    throw new HarnessError("MODEL_SELECTOR_UNAVAILABLE", { resolution: "The host Pi runtime cannot provide its model selector. Restart with a supported host." });
  }
  const existing = views.get(runtime);
  if (existing) return existing;
  const view = new Proxy(runtime, {
    get(target, key): unknown {
      if (key === "getAvailableSnapshot") return () => target.getAvailableSnapshot().filter((model) => model.api !== "pi-virtual");
      if (key === "getModel") return (provider: string, id: string) => {
        const model = target.getModel(provider, id);
        return model?.api === "pi-virtual" ? undefined : model;
      };
      const value: unknown = Reflect.get(target, key, target);
      const bound: unknown = typeof value === "function" ? value.bind(target) : value;
      return bound;
    },
  });
  views.set(runtime, view);
  return view;
}

/** Reuse /model's public UI, but never its main-model/default-setting handlers. */
export function createPresetModelSelector(options: {
  tui: TUI;
  runtime: ModelRuntime | undefined;
  current: Model | undefined;
  scopedModels: readonly ScopedModel[];
  select(model: Model): void;
  cancel(): void;
}): ModelSelectorComponent {
  if (!hasScopeSnapshot(options.scopedModels)) {
    throw new HarnessError("MODEL_SELECTOR_UNAVAILABLE", { resolution: "The host Pi context must expose its current scoped-model snapshot." });
  }
  const scoped = options.scopedModels.filter(({ model }) => model.api !== "pi-virtual");
  return new ModelSelectorComponent(options.tui, options.current, physicalView(options.runtime), scoped,
    (model: Model) => options.select(model), () => options.cancel());
}
