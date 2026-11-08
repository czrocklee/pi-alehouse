// Repair the pinned grammar's missing backquote host BEFORE command/path/effect
// collection. Only AST-confirmed expanding heredocs are inspected. No policy or
// verdict is cached; prose and interpreter strings are never shell programs.
import type { TSNode } from "./parser.ts";

type Tree = { rootNode: TSNode; delete(): void };
type Parser = { parse(source: string): Tree | null; delete(): void };
type LinkedNode = TSNode & { parent: LinkedNode | null };
type Position = (index: number) => number;
type Entry = { node: TSNode; position: Position; depth: number };
const MAX_SUBSTITUTIONS = 256;
const MAX_RECOVERY_DEPTH = 16;
const MAX_RECOVERY_CHARACTERS = 1024 * 1024;
const incompleteRoots = new WeakSet<object>();
const originalSources = new WeakMap<object, string>();
const textOffsets = new WeakMap<object, Map<object, number>>();

/** Source-analysis completeness only; never permission state. */
export function heredocExecutionIncomplete(root: TSNode): boolean {
  return incompleteRoots.has(root);
}

/** Decoded text coordinates are distinct from absolute original-source spans. */
export function heredocTextOffset(parent: TSNode, child: TSNode): number {
  return textOffsets.get(parent)?.get(child) ?? child.startIndex - parent.startIndex;
}

/** A decoded node cannot claim byte-identical original-source query proof. */
export function heredocOriginalSource(node: TSNode): string | undefined {
  return originalSources.get(node);
}

function childrenOf(node: TSNode): TSNode[] {
  const children: TSNode[] = [];
  for (let i = 0; i < node.childCount; i++) children.push(node.child(i)!);
  return children;
}

function expandingBody(node: TSNode): TSNode | undefined {
  if (node.type !== "heredoc_redirect" || node.hasError) return;
  const children = childrenOf(node);
  const delimiter = children.find((child) => child.type === "heredoc_start");
  if (!delimiter || /["'\\]/.test(delimiter.text)) return;
  return children.find((child) => child.type === "heredoc_body");
}

function needsCorrection(node: TSNode): boolean {
  if (node.type === "ERROR") return false;
  if (expandingBody(node)?.text.includes("`")) return true;
  return childrenOf(node).some(needsCorrection);
}

function substitutionOf(node: TSNode, length: number): TSNode | undefined {
  if (node.type === "command_substitution" && node.startIndex === 0 && node.endIndex === length)
    return node;
  for (const child of childrenOf(node)) {
    const found = substitutionOf(child, length);
    if (found) return found;
  }
  return;
}

/** Legacy backquotes remove these escapes BEFORE parsing the inner shell. */
function decodedPayload(span: string): { source: string; boundaries: number[] } {
  const raw = span.slice(1, -1);
  let source = "";
  const boundaries = [0];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === "\\" && /[$`\\]/.test(raw[i + 1] ?? "")) i++;
    source += raw[i++];
    boundaries.push(i);
  }
  return { source, boundaries };
}

function correctedTree(tree: Tree, parser: Parser): Tree {
  if (!needsCorrection(tree.rootNode)) return tree;
  const temporaryTrees: Tree[] = [];
  const overrides = new Map<TSNode, Entry[]>();
  const wholeSource = tree.rootNode.text;
  const wholeStart = tree.rootNode.startIndex;
  let remaining = MAX_SUBSTITUTIONS;
  let characters = MAX_RECOVERY_CHARACTERS;
  let incomplete = false;
  const parse = (source: string): Tree | undefined => {
    if ((characters -= source.length) < 0) {
      incomplete = true;
      return;
    }
    try {
      const parsed = parser.parse(source);
      if (parsed) temporaryTrees.push(parsed);
      else incomplete = true;
      return parsed ?? undefined;
    } catch {
      incomplete = true;
      return;
    }
  };

  const bodyEntries = (body: TSNode, position: Position, depth: number): Entry[] => {
    const original = childrenOf(body);
    const parsed = original.filter((child) => child.isNamed && child.type !== "heredoc_content");
    const source = body.text;
    const ranges: Array<{ start: number; end: number }> = [];
    const recovered: Entry[] = [];
    for (let i = 0; i < source.length;) {
      // Existing $(...) owns its interior quote context. Inverse DATA such as
      // $(printf '%s' '`sudo true`') cannot open a heredoc-level backquote.
      const existing = parsed.find(
        (child) => i >= child.startIndex - body.startIndex && i < child.endIndex - body.startIndex,
      );
      if (existing) {
        i = existing.endIndex - body.startIndex;
        continue;
      }
      if (source[i] === "\\" && /[$`\\\n]/.test(source[i + 1] ?? "")) {
        i += 2;
        continue;
      }
      if (source[i] !== "`") {
        i++;
        continue;
      }
      const start = i++;
      let end = -1;
      // Inside an omitted host, old $() children may be MIS-PARENTED DATA.
      // They must be replaced, not trusted to decide this host's quoting.
      for (; i < source.length; i++) {
        if (source[i] === "\\" && /[$`\\\n]/.test(source[i + 1] ?? "")) {
          i++;
          continue;
        }
        if (source[i] === "`") {
          end = ++i;
          break;
        }
      }
      ranges.push({
        start: body.startIndex + start,
        end: body.startIndex + (end < 0 ? source.length : end),
      });
      if (end < 0) {
        incomplete = true;
        break;
      }
      if (depth >= MAX_RECOVERY_DEPTH || remaining-- <= 0) {
        incomplete = true;
        continue;
      }
      const span = source.slice(start, end);
      const full = parse(span);
      const context = full && substitutionOf(full.rootNode, span.length);
      if (!context) {
        incomplete = true;
        continue;
      }
      const absolute: Position = (index) => position(body.startIndex + start + index);
      if (/\\[$`\\]/.test(span.slice(1, -1))) {
        // The grammar treats escaped nested ticks as words. Reparse the
        // actual decoded inner shell, mapping EVERY boundary back to original
        // source; a constant shift would corrupt later path/provenance order.
        const decoded = decodedPayload(span);
        const inner = parse(decoded.source);
        if (!inner) continue;
        const innerPosition: Position = (index) => absolute(1 + decoded.boundaries[index]!);
        const adapted: TSNode = {
          type: "command_substitution",
          text: span,
          startIndex: 0,
          endIndex: span.length,
          isNamed: true,
          hasError: inner.rootNode.hasError,
          previousSibling: null,
          childCount: 0,
          child: () => null,
        };
        overrides.set(
          adapted,
          childrenOf(inner.rootNode).map((node) => ({
            node,
            position: innerPosition,
            depth: depth + 1,
          })),
        );
        recovered.push({ node: adapted, position: absolute, depth: depth + 1 });
      } else {
        if (full!.rootNode.hasError) {
          incomplete = true;
          continue;
        }
        recovered.push({ node: context, position: absolute, depth: depth + 1 });
      }
    }
    return [
      ...original
        .filter(
          (child) =>
            !ranges.some((range) => child.startIndex < range.end && child.endIndex > range.start),
        )
        .map((node) => ({ node, position, depth })),
      ...recovered,
    ].sort((a, b) => a.position(a.node.startIndex) - b.position(b.node.startIndex));
  };

  // Detached nodes keep exact absolute source spans and rebuilt parent/sibling
  // links, including redirected argv tails. Decoded text retains separate raw
  // provenance and never pretends to be byte-identical source for auto reads.
  const clone = (
    node: TSNode,
    position: Position,
    depth: number,
    parent: LinkedNode | null,
    previousSibling: LinkedNode | null,
    expand = false,
  ): LinkedNode => {
    const children: LinkedNode[] = [];
    const result: LinkedNode = {
      type: node.type,
      text: node.text,
      startIndex: position(node.startIndex),
      endIndex: position(node.endIndex),
      isNamed: node.isNamed,
      hasError: node.hasError,
      parent,
      previousSibling,
      get childCount() {
        return children.length;
      },
      child: (index) => children[index] ?? null,
    };
    const raw = wholeSource.slice(result.startIndex - wholeStart, result.endIndex - wholeStart);
    if (raw !== result.text) originalSources.set(result, raw);
    const body = expandingBody(node);
    const entries =
      overrides.get(node) ??
      (expand
        ? bodyEntries(node, position, depth)
        : childrenOf(node).map((child) => ({ node: child, position, depth })));
    const offsets = new Map<object, number>();
    textOffsets.set(result, offsets);
    for (const entry of entries) {
      const child = clone(
        entry.node,
        entry.position,
        entry.depth,
        result,
        children.at(-1) ?? null,
        body !== undefined && entry.node.type === "heredoc_body",
      );
      offsets.set(
        child,
        entry.position === position
          ? entry.node.startIndex - node.startIndex
          : child.startIndex - result.startIndex,
      );
      children.push(child);
    }
    return result;
  };
  try {
    const rootNode = clone(tree.rootNode, (index) => index, 0, null, null);
    if (incomplete) incompleteRoots.add(rootNode);
    return { rootNode, delete: () => tree.delete() };
  } catch (error) {
    tree.delete();
    throw error;
  } finally {
    for (const temporary of temporaryTrees) temporary.delete();
  }
}

/** Async initialization need not warm the separate synchronous advisory API. */
export function managedHeredocParser(parser: Parser): Parser {
  return {
    parse(source) {
      const tree = parser.parse(source);
      return tree ? correctedTree(tree, parser) : null;
    },
    delete: () => parser.delete(),
  };
}
