// Literal file-redirect targets. A redirect destination is a filename by
// syntax, so a literal one must reach the path projections even when it is new
// (no existence probe) or shaped like an option/assignment (`-d/x`, `N=d/x`).
// Non-literal targets keep upstream handling; this is not a permission grant.
import { parseUnresolvedAt, type TSNode } from "./parser.ts";

// Characters that expand (parameters, commands, globs, braces) or that a
// single word node should never carry unescaped. Anything else -- Unicode,
// `!` (no history expansion outside interactive shells), `=`, `-`, `#`, `~`
// past the first character -- is an ordinary filename character.
const EXPANDING = new Set(["$", "`", "*", "?", "[", "]", "{", "}", "(", ")", "'", '"']);

/** An unquoted word, backslash escapes removed; undefined if it may expand. */
function unquotedWord(text: string, first: boolean): string | undefined {
  if (first && text.startsWith("~")) return undefined; // tilde expansion
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\") {
      const next = text[++i];
      if (next === undefined) return undefined;
      if (next !== "\n") out += next; // backslash-newline is a continuation
    } else if (EXPANDING.has(char)) return undefined;
    else out += char;
  }
  return out;
}

/** Double-quoted content: only \$ \` \" \\ and \newline are escapes. */
function doubleQuoted(text: string): string | undefined {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "\\") {
      const next = text[i + 1];
      if (next !== undefined && '$`"\\\n'.includes(next)) {
        i++;
        if (next !== "\n") out += next;
      } else out += char;
    } else if (char === "$" || char === "`") return undefined;
    else out += char;
  }
  return out;
}

function literalText(node: TSNode, first: boolean): string | undefined {
  switch (node.type) {
    case "word":
      return unquotedWord(node.text, first);
    case "number":
      return /^\d+$/.test(node.text) ? node.text : undefined;
    case "raw_string": {
      const text = node.text;
      return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
        ? text.slice(1, -1)
        : undefined;
    }
    case "string": {
      let out = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) return undefined;
        if (child.type === '"') continue;
        // Expansions are their own children, never literal.
        if (child.type !== "string_content") return undefined;
        const part = doubleQuoted(child.text);
        if (part === undefined) return undefined;
        out += part;
      }
      return out;
    }
    case "concatenation": {
      let out = "";
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const part = child ? literalText(child, first && i === 0) : undefined;
        if (part === undefined) return undefined;
        out += part;
      }
      return out;
    }
    default:
      return undefined;
  }
}

function operatorOf(redirect: TSNode): string {
  for (let i = 0; i < redirect.childCount; i++) {
    const child = redirect.child(i);
    if (child && !child.isNamed) return child.type;
  }
  return "";
}

const DUPLICATING = new Set([">&", "<&"]);

/**
 * The pinned grammar has no <> operator. It strands one operator character in
 * an ERROR, either inside the redirect or immediately before it. Recover only
 * that byte-adjacent spelling, not unrelated parse errors. This identifies the
 * destination/argv boundary, never a command or effect proof.
 */
export function recoveredReadWriteRedirect(redirect: TSNode): boolean {
  if (redirect.type !== "file_redirect" || !parseUnresolvedAt(redirect)) return false;
  if (/^\d*<>/.test(redirect.text)) return true;
  const previous = redirect.previousSibling;
  return (
    redirect.text.startsWith(">") &&
    previous?.type === "ERROR" &&
    previous.text === "<" &&
    previous.endIndex === redirect.startIndex
  );
}

/** Only the discarded <> operator, never a destination or a nested execution. */
export function recoveredReadWriteOperator(redirect: TSNode, child: TSNode): boolean {
  return (
    recoveredReadWriteRedirect(redirect) &&
    child.type === "ERROR" &&
    (child.text === "<" || child.text === ">")
  );
}

/** A numeric tail word is argv, not the redirect grammar's descriptor node. */
export function redirectArgumentNode(node: TSNode): TSNode {
  if (node.type !== "number") return node;
  return {
    type: "word",
    text: node.text,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    childCount: 0,
    isNamed: true,
    hasError: node.hasError,
    previousSibling: node.previousSibling,
    child: () => null,
  };
}

/**
 * True when `child` is a `number` a file redirect opens as a file: `>123`,
 * `<123` and `&>1` name files; only `>&` / `<&` make a number a descriptor.
 */
export function redirectNumberNamesFile(redirect: TSNode, child: TSNode): boolean {
  return (
    redirect.type === "file_redirect" &&
    child.type === "number" &&
    !DUPLICATING.has(operatorOf(redirect))
  );
}

/**
 * The filename a file redirect names verbatim, or undefined when the shell
 * would expand it or it names a descriptor (`>&2`, `<&0`, `>&-`).
 */
export function literalRedirectTarget(redirect: TSNode, destination: TSNode): string | undefined {
  if (redirect.type !== "file_redirect") return undefined;
  const text = literalText(destination, true);
  if (!text) return undefined;
  const operator = operatorOf(redirect);
  if (DUPLICATING.has(operator) && (text === "-" || /^\d+$/.test(text))) return undefined;
  return text;
}
