import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export type WorkspaceObservation = Readonly<
  | { kind: "clone" | "worktree" | "cd" | "git -C"; path: string; bashExitZero: boolean }
  | { kind: "temporary clone" }
>;

const MAX_COMMAND = 4096;
const MAX_ROWS = 8;
const MAX_PENDING = 16;
const MAX_TRACKED_IDS = 256;
const MAX_PATH = 256;
export const EMPTY_WORKSPACE_OBSERVATIONS: readonly WorkspaceObservation[] = Object.freeze([]);
const field = (value: unknown, name: string): unknown =>
  value && typeof value === "object" && Object.hasOwn(value, name)
    ? (value as Record<string, unknown>)[name]
    : undefined;

// A deliberately small shell subset, not an authority parser. Recognize simple
// words and top-level newline/;/&& only, skipping comments and simple file
// redirects for cd hints. The one substitution exception is a standalone
// mktemp assignment, used as a hint, never evaluated.
const SHELL_CONTROL =
  /^(?:if|then|elif|else|fi|for|select|while|until|do|done|case|esac|function|coproc|time)$/;

function spaceEnd(text: string, offset: number): number {
  while (text[offset] === " " || text[offset] === "\t") offset++;
  return offset;
}

function nameEnd(text: string, offset: number): number | undefined {
  if (!/[A-Za-z_]/.test(text[offset] ?? "")) return undefined;
  offset++;
  while (/\w/.test(text[offset] ?? "")) offset++;
  return offset;
}

function variableEnd(text: string, dollar: number): number | undefined {
  const braces = text[dollar + 1] === "{";
  const end = nameEnd(text, dollar + (braces ? 2 : 1));
  if (end === undefined || (braces && text[end] !== "}")) return undefined;
  return end + (braces ? 1 : 0);
}

function mktempEnd(text: string, open: number, quoted: boolean): number | undefined {
  const name = spaceEnd(text, open + 2);
  if (!text.startsWith("mktemp", name)) return undefined;
  const flag = spaceEnd(text, name + 6);
  if (flag === name + 6 || !text.startsWith("-d", flag)) return undefined;
  let offset = flag + 2;
  for (;;) {
    const next = spaceEnd(text, offset);
    if (text[next] === ")")
      return quoted ? (text[next + 1] === '"' ? next + 2 : undefined) : next + 1;
    if (next === offset) return undefined;
    offset = next;
    while (/[\w./-]/.test(text[offset] ?? "")) offset++;
    if (offset === next) return undefined;
  }
}

function wordEnd(text: string, start: number, literalOnly = false): number | undefined {
  const quote = text[start];
  if (quote === '"' || quote === "'") {
    let offset = start + 1;
    while (offset < text.length) {
      const char = text[offset];
      if (char === quote) return offset + 1;
      if (char === "\n") return undefined;
      if (quote === '"') {
        if (char === "\\" || char === "`") return undefined;
        if (char === "$") {
          if (literalOnly) return undefined;
          const end = variableEnd(text, offset);
          if (end === undefined) return undefined;
          offset = end;
          continue;
        }
      }
      offset++;
    }
    return undefined;
  }

  const name = literalOnly ? undefined : nameEnd(text, start);
  if (name !== undefined && text[name] === "=") {
    if (text.startsWith("$?", name + 1)) return name + 3; // Opaque exit-status assignment.
    const quoted = text[name + 1] === '"';
    const open = name + (quoted ? 2 : 1);
    if (text.startsWith("$(", open)) return mktempEnd(text, open, quoted);
  }

  let offset = start;
  while (offset < text.length) {
    if (text[offset] === "$") {
      if (literalOnly) return undefined;
      const end = variableEnd(text, offset);
      if (end === undefined) return undefined;
      offset = end;
    } else if (text[offset] === "#" && !literalOnly && offset > start) offset++;
    else if (/[\w@%+=:,./-]/.test(text[offset] ?? "")) offset++;
    else break;
  }
  return offset === start ? undefined : offset;
}

function redirectEnd(text: string, start: number): number | undefined {
  const char = text[start];
  const next = text[start + 1];
  if (char === "<" && next === "<") return undefined; // No heredocs or here-strings.
  let target = start + 1;
  if (char === "&") {
    target += text[start + 2] === ">" ? 2 : 1; // &> or &>>
  } else if (next === ">" || next === "&" || (char === ">" && next === "|")) {
    target++;
  }
  return wordEnd(text, spaceEnd(text, target), true);
}

function segments(command: string): { commands: string[][]; cdOnly: boolean } | undefined {
  if (/[^\x20-\x7e\n\t]/.test(command)) return undefined;
  const commands: string[][] = [];
  let words: string[] = [];
  let offset = 0;
  let afterToken = false;
  let needsCommand = false;
  let cdOnly = false;
  // Always advance or stop. There is no retry on malformed input; an
  // unsupported construct anywhere drops the whole request.
  while (offset < command.length) {
    const next = spaceEnd(command, offset);
    if (next === command.length) break;
    const char = command[next];
    const adjacent = afterToken && next === offset;
    if (char === "#" && !adjacent) {
      cdOnly = true;
      const end = command.indexOf("\n", next + 1);
      offset = end < 0 ? command.length : end;
      continue;
    }
    const op =
      char === "\n" || char === ";" ? char : command.startsWith("&&", next) ? "&&" : undefined;
    if (op) {
      if (!afterToken && op !== "\n") return undefined;
      if (words.length) commands.push(words);
      words = [];
      afterToken = false;
      if (op === "&&") needsCommand = true;
      offset = next + op.length;
      continue;
    }
    if (char === "<" || char === ">" || command.startsWith("&>", next)) {
      const end = redirectEnd(command, next);
      if (end === undefined) return undefined;
      cdOnly = true;
      offset = end;
    } else {
      if (adjacent) return undefined; // Shell word concatenation.
      const end = wordEnd(command, next);
      if (end === undefined) return undefined;
      const token = command.slice(next, end);
      offset = end;
      // Only an unquoted numeric word touching < or > is an IO number.
      if ((command[end] === "<" || command[end] === ">") && /^\d+$/.test(token)) continue;
      if (!words.length && SHELL_CONTROL.test(token)) return undefined;
      if (char !== "'" && char !== '"' && token.includes("#")) {
        // Only treat the extra syntax as opaque argv, never as a cd operand.
        if (!words.length || words[0] === "cd") return undefined;
        cdOnly = true;
      }
      if (token.endsWith("=$?")) cdOnly = true;
      words.push(token);
    }
    afterToken = true;
    needsCommand = false;
  }
  if (needsCommand) return undefined;
  if (words.length) commands.push(words);
  return { commands, cdOnly };
}

const unquote = (word: string): string =>
  word.startsWith('"') || word.startsWith("'") ? word.slice(1, -1) : word;

function literalPath(word: string): string | undefined {
  const path = unquote(word);
  if (
    path.length > MAX_PATH ||
    path.trim() !== path ||
    path.startsWith("-") ||
    !/^[\w./ -]+$/.test(path)
  )
    return undefined;
  // Do not retain an engine substring backed by the original command.
  return Buffer.from(path).toString();
}

const CLONE_SWITCH = /^(?:-q|--quiet|--single-branch|--no-tags)$/;
const WORKTREE_SWITCH = /^(?:-f|--force|--detach|--no-checkout)$/;
const CLONE_VALUE = /^(?:-b|--branch|--depth|--filter)$/;
const WORKTREE_VALUE = /^(?:-b|-B)$/;

function target(words: string[], kind: "clone" | "worktree"): string | undefined {
  const clone = kind === "clone";
  const value = clone ? CLONE_VALUE : WORKTREE_VALUE;
  const toggle = clone ? CLONE_SWITCH : WORKTREE_SWITCH;
  let i = clone ? 2 : 3;
  for (; i < words.length; i++) {
    const word = words[i]!;
    if (word === "--") {
      i++;
      break;
    }
    if (toggle.test(word)) continue;
    const [flag = "", inline] = word.split("=", 2);
    if (!value.test(flag)) break;
    const arg = unquote(inline ?? words[++i] ?? "");
    if (!/^[\w./:-]+$/.test(arg) || arg.startsWith("-")) return;
  }
  const first = words[i];
  const second = words[i + 1];
  if (
    !first ||
    unquote(first).startsWith("-") ||
    (second !== undefined && unquote(second).startsWith("-")) ||
    words.length > i + 2
  )
    return undefined;
  return clone ? second : first;
}

function candidates(
  command: string,
): { rows: WorkspaceObservation[]; literalStandalone: boolean } | undefined {
  if (command.length > MAX_COMMAND || !/\b(?:git|cd)\b/.test(command)) return undefined;
  const parsed = segments(command);
  if (!parsed) return undefined;
  const { commands, cdOnly } = parsed;
  const rows: WorkspaceObservation[] = [];
  let temps: Set<string> | undefined;
  for (const words of commands) {
    const [name, action, arg] = words;
    if (cdOnly && name !== "cd") continue; // Do not extend Git observations or exit evidence.
    if (name && words.length === 1) {
      const assigned = /^([A-Za-z_]\w*)=/.exec(name)?.[1];
      if (assigned) {
        // The tokenizer admits only the literal mktemp form after this prefix.
        const start = assigned.length + 1;
        if (name.startsWith("$(", start) || name.startsWith('"$(', start))
          (temps ??= new Set()).add(assigned);
        else temps?.delete(assigned);
      }
    }
    let kind: "clone" | "worktree" | "git -C" | "cd" | undefined;
    if (name === "git") {
      if (action === "clone") kind = "clone";
      else if (action === "worktree" && arg === "add") kind = "worktree";
      else if (action === "-C" && words.length >= 4) kind = "git -C";
    } else if (name === "cd" && words.length === 2) kind = "cd";
    if (!kind) continue;
    const operand =
      kind === "clone" || kind === "worktree" ? target(words, kind) : kind === "cd" ? action : arg;
    if (!operand) continue;
    const path = literalPath(operand);
    if (path) rows.push({ kind, path, bashExitZero: false });
    else if (kind === "clone" && temps && !operand.startsWith("'")) {
      const dynamic = unquote(operand);
      const end = dynamic.startsWith("$") ? variableEnd(dynamic, 0) : undefined;
      if (
        end !== undefined &&
        (end === dynamic.length || /^\/[\w./-]+$/.test(dynamic.slice(end)))
      ) {
        const variable = dynamic[1] === "{" ? dynamic.slice(2, end - 1) : dynamic.slice(1, end);
        if (temps.has(variable)) rows.push({ kind: "temporary clone" });
      }
    }
    if (rows.length === MAX_ROWS) break;
  }
  // Expansion could change other operands/options even with a literal destination.
  return rows.length
    ? { rows, literalStandalone: !cdOnly && commands.length === 1 && !command.includes("$") }
    : undefined;
}

const key = (row: WorkspaceObservation): string =>
  row.kind === "temporary clone" ? row.kind : `${row.kind}:${row.path}`;
type Attempt = NonNullable<ReturnType<typeof candidates>> & { order: number };
type WorkspaceRun = { observe(event: AgentSessionEvent): void; clear(): void };
const RETIRED_RUN: WorkspaceRun = Object.freeze({ observe() {}, clear() {} });

/** Per-child-session metadata. Each subscription pairs only its own Run's
 * events. The retained snapshot cannot change cwd, permissions or evidence. */
export class WorkspaceMonitor {
  private rows = EMPTY_WORKSPACE_OBSERVATIONS;
  private order = 0;
  private readonly recent: { id: string; order: number; row: WorkspaceObservation }[] = [];
  private readonly watchers = new Set<{ reset(): void; clear(): void }>();
  private retired = false;

  // A zero delta still means the retained rows were replaced, e.g. at the cap.
  constructor(private onRowsChanged?: (delta: number) => void) {}

  snapshot(): readonly WorkspaceObservation[] {
    return this.rows;
  }

  private publish(rows: readonly WorkspaceObservation[]): void {
    const delta = rows.length - this.rows.length;
    this.rows = rows;
    this.onRowsChanged?.(delta);
  }

  reset(): boolean {
    for (const watch of this.watchers) watch.reset();
    this.recent.length = 0;
    this.order = 0;
    if (this.rows.length === 0) return false;
    this.publish(EMPTY_WORKSPACE_OBSERVATIONS);
    return true;
  }

  /** Owner retention ended, not merely the current Run. */
  retire(): void {
    this.retired = true;
    for (const watch of this.watchers) watch.clear();
    this.reset();
    this.onRowsChanged = undefined;
  }

  watchRun(): WorkspaceRun {
    if (this.retired) return RETIRED_RUN;
    const pending = new Map<string, Attempt | undefined>();
    const seen = new Set<string>();
    let closed = false;
    let resetSinceStart = false;
    const reset = () => {
      // Release old paths and exit candidates but retain the bounded ID fence.
      pending.clear();
      resetSinceStart = true;
    };
    const clear = () => {
      closed = true;
      pending.clear();
      seen.clear();
      this.watchers.delete(watch);
    };
    const watch = { reset, clear };
    this.watchers.add(watch);
    return {
      observe: (event) => {
        if (closed) return;
        if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
        if (event.toolName !== "bash") return;
        const id = event.toolCallId;
        if (typeof id !== "string" || !id || id.length > 256) return;
        const reused = seen.has(id);
        const start = event.type === "tool_execution_start";
        if (!reused) {
          // Keep a Run-local fence even for starts dropped at the pending cap,
          // or for an end without a start. Never evict and risk accepting a reuse.
          if (seen.size === MAX_TRACKED_IDS) {
            // A possibly stale end must not discard new pending hints. At the
            // cap its unseen ID cannot be admitted anyway.
            if (start || !resetSinceStart) clear();
            return;
          }
          const retainedId = Buffer.from(id, "utf16le").toString("utf16le");
          seen.add(retainedId);
          if (start && pending.size < MAX_PENDING) {
            const command = field(event.args, "command");
            const parsed = typeof command === "string" ? candidates(command) : undefined;
            pending.set(retainedId, parsed && { ...parsed, order: ++this.order });
          }
          return;
        }
        if (start) {
          // No end can disambiguate multiple starts.
          pending.delete(id);
          return;
        }
        const match = pending.get(id);
        pending.delete(id);
        // Blocked and invalid calls get start/end events too, but no duration.
        const duration = event.durationMs;
        if (!match || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
          return;
        const recent = this.recent;
        let changed = false;
        for (const row of match.rows) {
          const id = key(row);
          const same = recent.findIndex((item) => item.id === id);
          // Parallel tool completions need not follow tool-start order.
          if (same >= 0 && recent[same]!.order > match.order) continue;
          const before = recent.findIndex((item) => item.order <= match.order);
          if (before < 0 && recent.length === MAX_ROWS) continue;
          // The start event is pre-hook input and the tool may apply a shell
          // prefix. Zero is a Bash result, not proof the requested Git ran.
          const bashExitZero =
            (row.kind === "clone" || row.kind === "worktree") &&
            match.literalStandalone &&
            event.isError === false &&
            field(field(event.result, "structuredContent"), "exit_code") === 0;
          // A replaced row is at or after the insertion point.
          if (same >= 0) recent.splice(same, 1);
          recent.splice(before < 0 ? recent.length : before, 0, {
            id,
            order: match.order,
            row: Object.freeze(bashExitZero ? { ...row, bashExitZero } : row),
          });
          if (recent.length > MAX_ROWS) recent.pop();
          changed = true;
        }
        if (changed) this.publish(Object.freeze(recent.map((item) => item.row)));
      },
      clear,
    };
  }
}
