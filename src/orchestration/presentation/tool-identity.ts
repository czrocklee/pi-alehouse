import { singleLineText } from "./plain-text.ts";

/** Identifying paths only; no terminal-width or filesystem interpretation. */
export function relativeToolPath(value: string, cwd: string): string {
  const path = singleLineText(value),
    base = singleLineText(cwd);
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

export interface ToolArgumentFormat {
  path(value: string): string;
  text(value: string): string;
}

/** Shared argument selection; callers separately bound storage or painted width. */
export function identifyingToolArgs(
  name: string,
  args: unknown,
  cwd: string,
  format: ToolArgumentFormat = {
    path: (value) => relativeToolPath(value, cwd),
    text: singleLineText,
  },
): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof input[key] === "string" ? input[key] : undefined;
  const path = (key: string): string | undefined => {
    const value = str(key);
    return value ? format.path(value) : undefined;
  };
  switch (singleLineText(name)) {
    case "read":
    case "edit":
    case "write":
      return path("path");
    case "ls":
      return path("path") ?? ".";
    case "bash": {
      const command = str("command");
      return command ? format.text(command) : undefined;
    }
    case "grep":
    case "find": {
      const pattern = str("pattern");
      if (!pattern) return undefined;
      const where = path("path") ?? str("glob");
      return format.text(`"${pattern}"${where ? ` in ${where}` : ""}`);
    }
    case "ask_parent": {
      const question = str("question");
      return question ? format.text(question) : undefined;
    }
    case "alert_parent": {
      const message = str("message");
      return message ? format.text(message) : undefined;
    }
    default:
      return undefined;
  }
}
