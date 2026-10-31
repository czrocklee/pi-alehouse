// Argv buried in a redirect node. tree-sitter-bash parses `cmd 2>/dev/null a b`
// and `cmd <<EOF a` with `a b` inside the redirect, while Bash passes them to
// `cmd`. These helpers restore them as the owning command's argv for token
// roles and command rules. The real AST, execution text and redirect
// destination are never changed.
import { ARG_NODE_TYPES } from "./node-text";
import type { TSNode } from "./parser";

type Linked = TSNode & { readonly parent?: TSNode | null };
const parentOf = (node: TSNode): TSNode | null | undefined => (node as Linked).parent;
const REDIRECT_TYPES = new Set(["file_redirect", "heredoc_redirect", "herestring_redirect"]);
const SEQUENCE_TYPES = new Set(["list", "pipeline", "redirected_statement"]);
const TAIL_TYPES = new Set([...ARG_NODE_TYPES, "simple_expansion", "expansion", "command_substitution", "process_substitution", "number"]);
const same = (a: TSNode, b: TSNode): boolean => a.type === b.type && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

/** Words after the destination (all of them after a close), or after a heredoc delimiter. */
export function redirectTail(redirect: TSNode): TSNode[] {
  const values: TSNode[] = [];
  let close = false;
  for (let i = 0; i < redirect.childCount; i++) {
    const child = redirect.child(i)!;
    if (!child.isNamed) { if (/^[<>]&-$/.test(child.type)) close = true; continue; }
    if (redirect.type === "heredoc_redirect") {
      if (child.type === "heredoc_start" || child.type === "file_descriptor") continue;
      // A recovered heredoc line is not evidence of what the command receives.
      if (!TAIL_TYPES.has(child.type)) break;
    } else if (child.type === "file_descriptor") continue;
    values.push(child);
  }
  return redirect.type === "heredoc_redirect" || close ? values : values.slice(1);
}

/** The command whose argv a statement-level redirect's tail continues: the
 * last element of the redirected body, only when that element is a command. */
export function redirectTailOwner(redirect: TSNode): TSNode | undefined {
  const statement = parentOf(redirect);
  if (statement?.type !== "redirected_statement" || !REDIRECT_TYPES.has(redirect.type)) return;
  let node: TSNode | undefined = statement;
  for (let depth = 0; node && depth < 128; depth++) {
    let last: TSNode | undefined;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.startIndex >= redirect.startIndex) break;
      if (child.isNamed && child.type !== "comment" && !REDIRECT_TYPES.has(child.type)) last = child;
    }
    if (last?.type === "command") return last;
    node = last && SEQUENCE_TYPES.has(last.type) ? last : undefined;
  }
  return undefined;
}

/** Tails this command owns, in source order. */
export function ownedRedirectTails(command: TSNode): TSNode[] {
  const tails: TSNode[] = [];
  for (let node = parentOf(command), depth = 0; node && SEQUENCE_TYPES.has(node.type) && depth < 128; node = parentOf(node), depth++) {
    if (node.type !== "redirected_statement") continue;
    for (let i = 0; i < node.childCount; i++) {
      const redirect = node.child(i)!;
      if (!REDIRECT_TYPES.has(redirect.type) || redirect.startIndex < command.endIndex) continue;
      const owner = redirectTailOwner(redirect);
      if (owner && same(owner, command)) tails.push(...redirectTail(redirect));
    }
  }
  return tails.sort((a, b) => a.startIndex - b.startIndex);
}

/** A detached command view whose children include its buried argv. Without a
 * parent it owns no further tails; its text is the completed spelling. */
export function completedCommandView(command: TSNode): TSNode | undefined {
  const tails = ownedRedirectTails(command);
  if (!tails.length) return undefined;
  const children: TSNode[] = [];
  for (let i = 0; i < command.childCount; i++) children.push(command.child(i)!);
  children.push(...tails);
  return {
    type: command.type, text: [command.text, ...tails.map(tail => tail.text)].join(" "),
    startIndex: command.startIndex, endIndex: command.endIndex, childCount: children.length,
    isNamed: command.isNamed, hasError: command.hasError, previousSibling: command.previousSibling,
    child: index => children[index] ?? null,
  };
}
