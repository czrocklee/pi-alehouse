import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TObject, TSchema } from "typebox";
import type { OwnerController } from "../core/owner-controller.ts";
import { packIndependentCommunication } from "../core/communication-packer.ts";
import type { CommunicationToolResult } from "../core/communication-snapshot.ts";
import { HarnessError } from "../core/ports.ts";
import { defaultDelegation, delegationGuideline } from "../delegation.ts";
import { errorReply, type ErrorNames } from "./replies.ts";
import { checkParentToolArguments } from "./parent-schemas.ts";

export interface ParentToolBinding {
  readonly cwd: string;
  assertCurrent(ctx: ExtensionContext): void;
  assertPrepared(ctx: ExtensionContext, signal?: AbortSignal): void;
  observe(
    request: Parameters<OwnerController["observe"]>[0],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<CommunicationToolResult>;
  independent(ctx: ExtensionContext, read: () => object): CommunicationToolResult;
  define<S extends TObject>(
    name: string,
    description: string,
    schema: S,
    action: (
      args: Static<S>,
      ctx: ExtensionContext,
      id: string,
      signal?: AbortSignal,
    ) => CommunicationToolResult | Promise<CommunicationToolResult>,
  ): ToolDefinition<TSchema, undefined, unknown>;
}

/** Capture the fixed parent identity once, then recheck it at entry and before
 * publication. Tool actions stay outside this binding. */
export function bindParentToolContext(input: {
  controller: OwnerController;
  boundContext: ExtensionContext;
  guideline?: string;
}): ParentToolBinding {
  const { controller, boundContext } = input;
  controller.assertEffectAllowed();
  const { identity, manager, cwd, registry } = controller.validateObservationEntry(() => {
    const identity = controller.identity,
      manager = boundContext.sessionManager,
      cwd = boundContext.cwd;
    const registry = boundContext.modelRegistry;
    if (manager.getSessionId() !== identity.owner_id)
      throw new HarnessError("OWNER_CONTEXT_MISMATCH");
    return { identity, manager, cwd, registry };
  });
  const names: ErrorNames = {
    agent: (id) => controller.agentName(id),
    run: (run_id) => controller.view(run_id).name,
  };
  const toolError = (error: unknown) =>
    new Error(
      JSON.stringify(
        errorReply(
          error instanceof HarnessError
            ? error
            : new HarnessError("TOOL_ERROR", { error: String(error) }),
          names,
        ),
      ),
      { cause: error },
    );
  const assertCurrent = (ctx: ExtensionContext) => {
    try {
      // Read BOTH contexts through SDK guarded getters. Equal session IDs alone
      // do not detect reload of the same session or a captured stale closure.
      if (
        boundContext.sessionManager !== manager ||
        ctx.sessionManager !== manager ||
        manager.getSessionId() !== identity.owner_id ||
        boundContext.cwd !== cwd ||
        ctx.cwd !== cwd ||
        boundContext.modelRegistry !== registry ||
        ctx.modelRegistry !== registry ||
        controller.identity.owner_id !== identity.owner_id ||
        controller.identity.generation !== identity.generation
      )
        throw new Error();
    } catch {
      throw new HarnessError("STALE_OWNER_CONTEXT", {
        resolution:
          "The harness session changed underneath this call; it may or may not have been accepted. Check agent_list before repeating it.",
      });
    }
  };
  const assertPrepared = (ctx: ExtensionContext, signal?: AbortSignal) => {
    assertCurrent(ctx);
    if (signal?.aborted) throw new HarnessError("TOOL_INTERRUPTED");
  };
  const observe = (
    request: Parameters<OwnerController["observe"]>[0],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ) => controller.observe(request, { validate: () => assertCurrent(ctx), signal });
  /** Only non-observation tools use this serializer, inside their own guarded
   * projection. No communication state or presentation references are touched. */
  const independent = (ctx: ExtensionContext, read: () => object): CommunicationToolResult =>
    controller.validateObservationEntry(() => {
      assertCurrent(ctx);
      return packIndependentCommunication(read() as Record<string, unknown>);
    });
  const define: ParentToolBinding["define"] = (name, description, schema, action) => {
    const checked = (raw: unknown) => checkParentToolArguments(name, schema, raw);
    return {
      name,
      label: name,
      description,
      parameters: schema,
      ...(name === "agent_spawn"
        ? { promptGuidelines: [input.guideline ?? delegationGuideline(defaultDelegation)] }
        : {}),
      prepareArguments(raw) {
        controller.assertEffectAllowed();
        try {
          return checked(raw);
        } catch (error) {
          throw toolError(error);
        }
      },
      // The synchronous facade rejects nested work before any Promise/queue or
      // callback begins. A swallowed rejection still taints the source frame.
      execute(id, raw, signal, _update, ctx) {
        controller.assertEffectAllowed();
        try {
          const args = controller.validateObservationEntry(() => {
            assertCurrent(ctx);
            return checked(raw);
          });
          if (typeof id !== "string" || !id) throw new HarnessError("INVALID_REQUEST_ID");
          if (name !== "agent_wait" && name !== "agent_read" && signal?.aborted)
            throw new HarnessError("TOOL_INTERRUPTED");
          // Observe's value is already serialized and committed. Only rejection
          // conversion is allowed here: no success-side check, UI, or wrapper.
          return Promise.resolve(action(args, ctx, id, signal)).catch((error: unknown) => {
            throw toolError(error);
          });
        } catch (error) {
          return Promise.reject(toolError(error));
        }
      },
    };
  };
  return { cwd, assertCurrent, assertPrepared, observe, independent, define };
}
