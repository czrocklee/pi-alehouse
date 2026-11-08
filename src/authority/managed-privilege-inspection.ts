// AST-only privilege execution inventory shared by local, parent and advisory
// gates. The parser supplies the SAME corrected heredoc quote contexts to every
// command/path collector; this collaborator never appends a second inventory.
import { collectCommands, type BashCommand } from "./command-enumeration.ts";
import { getParser, getWarmBashParser } from "./parser.ts";
import { heredocExecutionIncomplete } from "./managed-heredoc-execution.ts";
import { literalPrivilegeCommand, simplePrivilegeSource } from "./managed-privilege-command.ts";
import type { PermissionCheckResult } from "#src/types.ts";

type Parser = Awaited<ReturnType<typeof getParser>>;

export interface PrivilegeBashResolver {
  checkPrivilegeBashRestriction?(
    command: string,
    agentName?: string,
  ): PermissionCheckResult | undefined;
  hasPrivilegeBashRestriction?(agentName?: string): boolean;
}

/** Only real command nodes carry this fact; compound/ERROR prose never does. */
export function privilegeBashFloorFromCommands(
  commands: readonly BashCommand[],
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): PermissionCheckResult | undefined {
  for (const command of commands) {
    if (!command.managedPrivilegeCommand) continue;
    const check = resolver.checkPrivilegeBashRestriction?.(
      command.managedPrivilegeCommand,
      agentName,
    );
    if (check?.state === "deny")
      return { ...check, ...(command.context ? { commandContext: command.context } : {}) };
  }
  return;
}

function uninspectedFloor(command: string): PermissionCheckResult {
  return {
    state: "ask",
    toolName: "bash",
    source: "bash",
    origin: "fail-closed",
    command,
    matchedPattern: "<uninspected-privilege-command>",
    reason: "Global privilege-command denies could not be inspected; approval is required.",
  };
}

function uninspectedFloorIfActive(
  command: string,
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): PermissionCheckResult | undefined {
  return resolver.hasPrivilegeBashRestriction?.(agentName) ? uninspectedFloor(command) : undefined;
}

function failedInspection(
  command: string,
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): PermissionCheckResult | undefined {
  // Source-only proof first: ordinary literal commands and dynamic variables
  // cannot require this floor. Never sample policy merely to discover that no
  // privilege executable is present. No policy/verdict survives an await.
  if (simplePrivilegeSource(command)) {
    if (!literalPrivilegeCommand(command)) return;
    const direct = resolver.checkPrivilegeBashRestriction?.(command, agentName);
    return direct?.state === "deny" ? direct : undefined;
  }
  // Assignment/reserved prefixes and unknown nested source require AST role
  // proof; only incomplete inspection needs a global-floor presence query.
  const commentsOnly = command.split("\n").every((line) => /^[ \t]*(?:#|$)/.test(line));
  return commentsOnly ? undefined : uninspectedFloorIfActive(command, agentName, resolver);
}

function inspect(
  command: string,
  parser: Parser,
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): PermissionCheckResult | undefined {
  const tree = parser.parse(command);
  if (!tree) return failedInspection(command, agentName, resolver);
  try {
    // Recovered/opaque syntax keeps ordinary policy; do not add a global floor
    // merely because the grammar recovered an unrelated <> redirect error.
    return (
      privilegeBashFloorFromCommands(collectCommands(tree.rootNode), agentName, resolver) ??
      (heredocExecutionIncomplete(tree.rootNode)
        ? {
            ...uninspectedFloor(command),
            matchedPattern: "<uninspected-heredoc-execution>",
            reason:
              "The expanding heredoc execution source could not be fully inspected; approval is required.",
          }
        : undefined)
    );
  } finally {
    tree.delete();
  }
}

/** Full privately requested-source inspection for local and serving gates. */
export async function resolvePrivilegeBashFloor(
  command: string | undefined,
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): Promise<PermissionCheckResult | undefined> {
  if (command === undefined) return uninspectedFloorIfActive("", agentName, resolver);
  try {
    return inspect(command, await getParser(), agentName, resolver);
  } catch {
    return failedInspection(command, agentName, resolver);
  }
}

/** Same inventory, synchronous advisory API; cold parser never invents grants. */
export function resolvePrivilegeBashFloorSync(
  command: string,
  agentName: string | undefined,
  resolver: PrivilegeBashResolver,
): PermissionCheckResult | undefined {
  try {
    const parser = getWarmBashParser();
    return parser
      ? inspect(command, parser, agentName, resolver)
      : failedInspection(command, agentName, resolver);
  } catch {
    return failedInspection(command, agentName, resolver);
  }
}
