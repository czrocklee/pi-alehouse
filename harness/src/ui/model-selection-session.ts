import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import type { createPresetModelSelector } from "../runtime/preset-model-selector.ts";
import { HarnessError } from "../core/ports.ts";
import type { Strength } from "../routing.ts";
import type { ModelPickerPosition } from "./preset-picker.ts";
import { modelPopoverOptions, PresetModelPopover } from "./preset-model-popover.ts";

export interface ModelSelectionOptions {
  ctx: ExtensionContext;
  /** Runtime adaptation stays in composition, using the acquired host runtime. */
  createModelSelector?: (
    options: Omit<Parameters<typeof createPresetModelSelector>[0], "runtime">,
  ) => ReturnType<typeof createPresetModelSelector>;
  modelPopover?: () => boolean;
  /** Read-only permission-yield gate, rechecked for every queued factory. */
  modelSelectionAllowed?: () => boolean;
  beforeModelClose?: () => void;
}
type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

/** Owns model-dialog cancellation and mounting only, never settings, trust,
 * routing or permission authority. The caller revalidates before publication. */
export class ModelSelectionSession {
  private cancelPicker: (() => void) | undefined;
  constructor(
    private readonly options: ModelSelectionOptions,
    private readonly assertLive: () => void,
  ) {}

  /** Retires a queued factory too. Permission yield does not dispose the
   * surrounding preferences flow or cancel unrelated settings confirmations. */
  cancel(): void {
    const cancel = this.cancelPicker;
    this.cancelPicker = undefined;
    cancel?.();
  }

  async select(
    target: string,
    slot: Strength,
    previous: string,
    models: RegistryModel[],
    position?: ModelPickerPosition,
  ): Promise<string | undefined> {
    const { ctx } = this.options;
    const assertLive = this.assertLive;
    if (ctx.mode !== "tui") {
      const choices = [...new Set(models.map((model) => `${model.provider}/${model.id}`))].sort();
      const keep = previous && choices.includes(previous) ? `Keep ${previous}` : undefined;
      const picked = await ctx.ui.select(`${target}: ${slot} model (new Agents only)`, [
        ...(keep ? [keep] : []),
        ...choices,
      ]);
      assertLive();
      return picked === keep ? previous || undefined : picked;
    }
    if (this.options.modelSelectionAllowed?.() === false) return undefined;
    const createSelector = this.options.createModelSelector;
    if (!createSelector) throw new HarnessError("MODEL_SELECTOR_UNAVAILABLE");
    const floating = this.options.modelPopover?.() === true;
    let picker: ReturnType<typeof createPresetModelSelector> | undefined, terminal: TUI | undefined;
    let view: PresetModelPopover | undefined,
      finishRequest: (() => void) | undefined,
      cancelled = false;
    // Install ownership before enqueueing, not only after factory mount.
    const ownedCancel = (): void => {
      cancelled = true;
      finishRequest?.();
    };
    this.cancelPicker = ownedCancel;
    try {
      const selected = await ctx.ui.custom<RegistryModel | undefined>(
        (tui, theme, _keybindings, done) => {
          assertLive();
          if (this.options.modelSelectionAllowed?.() === false) cancelled = true;
          if (cancelled) throw new HarnessError("MODEL_SELECTION_CANCELLED");
          terminal = tui;
          const scopedModels = ctx.scopedModels;
          if (cancelled) throw new HarnessError("MODEL_SELECTION_CANCELLED");
          let settled = false;
          const finish = (model?: RegistryModel): void => {
            if (settled) return;
            settled = true;
            if (this.cancelPicker === ownedCancel) this.cancelPicker = undefined;
            try {
              this.options.beforeModelClose?.();
            } catch {
              /* UI cleanup must not block a permission ask. */
            }
            try {
              picker?.dispose();
            } finally {
              done(model);
            }
          };
          const select = (model: RegistryModel): void => {
            if (settled) return;
            if (!floating) return finish(model);
            const issue = view ? view.selectionIssue(model) : "not_visible";
            if (issue === undefined) return finish(model);
            if (issue === "closed") return;
            if (issue === "identity_unverified") {
              // Native Enter disposes before calling us. Settle a rejected
              // identity rather than stranding an already-dead selector.
              try {
                ctx.ui.notify(
                  "The selected model could not be verified against Pi's current registry and visible item. Nothing changed; reopen the model selector to refresh it.",
                  "warning",
                );
              } finally {
                finish();
              }
            } else {
              ctx.ui.notify(
                "The selected model is not fully visible. Enlarge the terminal or press Esc to cancel; nothing changed.",
                "warning",
              );
              tui.requestRender();
            }
          };
          picker = createSelector({
            tui,
            scopedModels,
            current: models.find((model) => `${model.provider}/${model.id}` === previous),
            select,
            cancel: ownedCancel,
          });
          assertLive();
          if (cancelled) throw new HarnessError("MODEL_SELECTION_CANCELLED");
          finishRequest = () => finish();
          const native = picker;
          if (floating) {
            view = new PresetModelPopover({
              native,
              theme,
              title: `${target}: ${slot} model`,
              height: () => Number(modelPopoverOptions(terminal, position).maxHeight),
              currentWidth: () => Number(modelPopoverOptions(terminal, position).width),
              models: () => ctx.modelRegistry.getAll(),
              select: finish,
              cancel: ownedCancel,
            });
            return view;
          }
          const title = new Text(
            theme.fg("accent", `${target}: ${slot} model · new Agents only; main unchanged`),
            0,
            0,
          );
          return {
            get focused(): boolean {
              return native.focused;
            },
            set focused(value: boolean) {
              native.focused = value;
            },
            get capturesViewportInput(): boolean {
              return native.capturesViewportInput === true;
            },
            render: (width: number) => [...title.render(width), ...native.render(width)],
            handleInput: (data: string) => native.handleInput(data),
            invalidate: () => {
              title.invalidate();
              native.invalidate();
            },
            dispose: () => native.dispose(),
          };
        },
        floating
          ? { overlay: true, overlayOptions: () => modelPopoverOptions(terminal, position) }
          : undefined,
      );
      assertLive();
      if (!selected) return undefined;
      if (selected.api === "pi-virtual") throw new HarnessError("PRESET_MODEL_UNAVAILABLE");
      return `${selected.provider}/${selected.id}`;
    } catch (error) {
      if (
        cancelled &&
        error instanceof HarnessError &&
        error.code === "MODEL_SELECTION_CANCELLED"
      ) {
        assertLive();
        return undefined;
      }
      throw error;
    } finally {
      // Old callbacks/finally blocks cannot retire a later request's owner.
      if (this.cancelPicker === ownedCancel) this.cancelPicker = undefined;
      picker?.dispose();
    }
  }
}
