/** Review evidence and input provenance. Packet facts never grant permissions. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import type { FailureCode } from "./jev-policy.ts";

const MAX_ACTION_TOKENS = 1_200;
const MAX_USER_CONTEXT_TOKENS = 8_192;
// Full selected restrictions need room for normal global + ancestor AGENTS.md.
// Delegated packets can carry two such sets: 2 * 2000 + 8192 user tokens still
// leaves room under the 16384 packet cap, which remains the final hard bound.
const MAX_PROJECT_RESTRICTION_TOKENS = 2_000;
const MAX_RECENT_TOOL_CALLS = 4;
const SENSITIVE_KEY =
  /(?:^|[_-])(?:api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;
export const CREDENTIAL_LITERAL =
  /(?:bearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{16}\b|(?:password|passwd|token|api[_-]?key|authorization|cookie)\s*[:=]\s*["']?[^\s"']{8,})/i;
/**
 * Selects the lines of a project instruction file that can only REDUCE
 * authority. The English half needs word boundaries; the Chinese half must not
 * have them, because `\b` is defined on ASCII word characters and never fires
 * between two CJK codepoints -- an English-only cue silently drops every
 * Chinese restriction this owner writes, and a dropped restriction is one the
 * constraint_conflict question is never shown.
 */
const RESTRICTIVE_CUE =
  /\b(?:avoid|cannot|can't|can’t|do not|don't|don’t|keep|may not|must|mustn't|mustn’t|never|only|prefer|preserve|required?|shall not|should|shouldn't|shouldn’t|unless|will not|won't|won’t|forbidden|prohibited|disallow|require[sd]? approval|ask (?:first|the user))\b|避免|不得|不要|仅限|只能|必须|保留|禁止|优先|严禁|请勿|切勿|不可|不准|不允许|未经|须(?:先|经)|需(?:要)?(?:先)?(?:批准|确认|授权)|征得同意/i;

type JsonPrimitive = string | number | boolean | null;
type CanonicalValue = JsonPrimitive | CanonicalValue[] | { [key: string]: CanonicalValue };
type ToolCallFact = { id: string | null; name: string; arguments: Record<string, unknown> };
type UserMessageFact = {
  branchIndex: number;
  text: string;
  source: "live_input" | "unverified_history";
};

export type UserAuthorizationContext = {
  messages: Array<{
    branchIndex: number;
    position: string;
    text: string;
    source: UserMessageFact["source"];
  }>;
  totalDirectUserMessages: number;
  omittedDirectUserMessages: number;
  totalUnverifiedUserMessages: number;
  omittedUnverifiedUserMessages: number;
  rawAuthorizationHistoryComplete: boolean;
};

type ProjectRestrictions = {
  entries: Array<{ source: string; section: string | null; text: string }>;
  sourceFileCount: number;
  /** Wire-compatible success invariant: known loss returns no packet at all. */
  budgetOmittedRestrictionLines: 0;
  selectionMethod: "restrictive_cue_filter";
  authorizationEffect: "restriction_only";
};

/** The binding layer supplies only this child's observed tool/request join. */
export type ChildToolObservations = {
  toolCalls?: Record<string, { name: string; arguments: Record<string, unknown> }>;
  requestTools?: Record<string, string>;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalize(value: unknown, seen = new WeakSet<object>()): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("cyclic value");
    seen.add(value);
    const result = value.map((item) => canonicalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("cyclic value");
    seen.add(value);
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol") continue;
      result[key] = canonicalize(child, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));
export const textDigest = (serialized: string): string =>
  createHash("sha256").update(serialized).digest("hex");
export const digest = (value: unknown): string => textDigest(canonicalJson(value));

/** Pessimistic on CJK, which the tokenizer does not divide. Over-counting costs a defer. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii);
}

function exactText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content.filter((part) => part?.type === "text");
  return texts.length === 1 && typeof texts[0].text === "string" ? texts[0].text : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function hasSensitiveKeyValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === "string") return CREDENTIAL_LITERAL.test(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitiveKeyValue(item, depth + 1));
  const record = asRecord(value);
  if (!record) return false;
  for (const [key, child] of Object.entries(record)) {
    if (SENSITIVE_KEY.test(key) && child !== null && child !== "") return true;
    if (hasSensitiveKeyValue(child, depth + 1)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Input provenance
 *
 * Pi has no input request ID, so a live user instruction is recognised by
 * matching an unqueued, unexpanded input against the next before_agent_start
 * and the actual live message object. Never recover provenance from text,
 * timestamps or persisted roles.
 * ------------------------------------------------------------------ */

export class InputProvenance {
  revision = 0;
  authorizationRevision = 0;
  private pending?: string;
  private expected?: string;
  private observed = new WeakMap<object, string>();

  input(event: { text: string; source: string; streamingBehavior?: string }): void {
    this.revision += 1;
    this.pending = undefined;
    this.expected = undefined;
    if (
      (event.source === "interactive" || event.source === "rpc") &&
      !event.streamingBehavior &&
      Boolean(event.text.trim()) &&
      !event.text.trimStart().startsWith("/") &&
      !/<\/?(?:file|skill)(?:\s|>)/i.test(event.text)
    ) {
      this.pending = event.text;
    }
  }

  /** `undefined` binds no input: a custom-message run, or an unrecognized /
   * malformed start shape that is never downgraded to a user prompt. */
  beforeStart(prompt: string | undefined): void {
    this.expected = prompt !== undefined && this.pending === prompt ? this.pending : undefined;
    this.pending = undefined;
  }

  message(message: { role?: string; content?: unknown }): boolean {
    if (message.role !== "user") return false;
    this.revision += 1;
    const text = exactText(message.content);
    const direct = this.expected !== undefined && text === this.expected;
    if (direct) {
      this.observed.set(message, text!);
      this.authorizationRevision += 1;
    }
    // Queued/injected messages cannot reuse the live-input ticket or reopen a refusal.
    this.expected = undefined;
    this.pending = undefined;
    return direct;
  }

  text(message: object & { content?: unknown }): string | undefined {
    const text = this.observed.get(message);
    return text !== undefined && text === exactText(message.content) ? text : undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Packet construction
 * ------------------------------------------------------------------ */

function userMessageFacts(
  branch: readonly unknown[],
  provenance: InputProvenance,
): UserMessageFact[] | undefined {
  const messages: UserMessageFact[] = [];
  for (let branchIndex = 0; branchIndex < branch.length; branchIndex += 1) {
    const entry = asRecord(branch[branchIndex]);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "user") continue;
    const live = provenance.text(message);
    const text = live ?? exactText(message.content);
    if (text === undefined) return undefined;
    messages.push({
      branchIndex,
      text,
      source: live === undefined ? "unverified_history" : "live_input",
    });
  }
  return messages;
}

export function buildUserContext(
  branch: readonly unknown[],
  provenance: InputProvenance,
): { ok: true; context: UserAuthorizationContext } | { ok: false; failureCode: FailureCode } {
  const facts = userMessageFacts(branch, provenance);
  // A queued or injected input after the last live instruction can change scope.
  // Wait for a fresh direct input rather than reviewing against stale authority.
  if (!facts || facts.at(-1)?.source !== "live_input") {
    return { ok: false, failureCode: "context_incomplete" };
  }
  const messages = facts.filter((message) => message.text !== "");
  const direct = messages.filter((message) => message.source === "live_input");
  if (!direct.length) return { ok: false, failureCode: "context_incomplete" };

  // First and latest live authorization stay complete; the rest fill the budget
  // newest-first. A credential-bearing optional turn is dropped rather than
  // making every later review defer as sensitive_context.
  const selected = new Set([messages.indexOf(direct[0]), messages.length - 1]);
  let tokens = estimateTokens(canonicalJson([...selected].map((index) => messages[index])));
  if (tokens > MAX_USER_CONTEXT_TOKENS) return { ok: false, failureCode: "context_oversize" };
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.has(index) || CREDENTIAL_LITERAL.test(messages[index].text)) continue;
    const candidate = tokens + estimateTokens(canonicalJson(messages[index])) + 1;
    if (candidate > MAX_USER_CONTEXT_TOKENS) continue;
    selected.add(index);
    tokens = candidate;
  }

  const ordered = [...selected].sort((left, right) => left - right).map((index) => messages[index]);
  const latestCompaction = branch.findLastIndex((entry) => asRecord(entry)?.type === "compaction");
  const omittedDirect = direct.length - ordered.filter((m) => m.source === "live_input").length;
  const omittedUnverified =
    messages.length -
    direct.length -
    ordered.filter((m) => m.source === "unverified_history").length;
  const rawAuthorizationHistoryComplete =
    omittedDirect === 0 &&
    omittedUnverified === 0 &&
    (latestCompaction < 0 || messages.some((m) => m.branchIndex < latestCompaction));
  // An omitted turn may be the restriction that changes the verdict. Counts in
  // the packet cannot substitute for the missing text, so never ask the model
  // to authorize from a lossy history.
  if (omittedDirect > 0 || omittedUnverified > 0) {
    return { ok: false, failureCode: "context_oversize" };
  }
  if (!rawAuthorizationHistoryComplete) {
    return { ok: false, failureCode: "context_incomplete" };
  }

  return {
    ok: true,
    context: {
      messages: ordered.map((message) => {
        const first = message.branchIndex === messages[0].branchIndex;
        const latest = message.branchIndex === messages[messages.length - 1].branchIndex;
        return {
          branchIndex: message.branchIndex,
          position:
            first && latest ? "first_and_latest" : first ? "first" : latest ? "latest" : "recent",
          text: message.text,
          source: message.source,
        };
      }),
      totalDirectUserMessages: direct.length,
      omittedDirectUserMessages: omittedDirect,
      totalUnverifiedUserMessages: messages.length - direct.length,
      omittedUnverifiedUserMessages: omittedUnverified,
      rawAuthorizationHistoryComplete,
    },
  };
}

/** Newest first, including order within a multi-call assistant message. Stop
 * as soon as the caller has its evidence; never materialize all historical calls.
 * Missing/non-string IDs and malformed arguments retain their old normalization. */
function* reverseToolCalls(branch: readonly unknown[]): Generator<ToolCallFact> {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(branch[index]);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = asRecord(message.content[blockIndex]);
      if (block?.type !== "toolCall" || typeof block.name !== "string") continue;
      yield {
        id: typeof block.id === "string" ? block.id : null,
        name: block.name,
        arguments: asRecord(block.arguments) ?? {},
      };
    }
  }
}

function lastToolCall(branch: readonly unknown[], id: string): ToolCallFact | undefined {
  for (const call of reverseToolCalls(branch)) if (call.id === id) return call;
  return undefined;
}

/** Binding supplies the forwarding identity/registry observation; this builder
 * shapes and bounds evidence without owning that registry or inferring a join. */
export function buildObservedAction(
  details: PromptPermissionDetails,
  branch: readonly unknown[],
  request: NonNullable<NonNullable<PromptPermissionDetails["payload"]>["request"]>,
  forwarding: { sessionId: string; agentName: string } | undefined,
  runtime: ChildToolObservations | undefined,
):
  | {
      ok: true;
      action: Record<string, unknown>;
      actionDigest: string;
      currentToolCall?: ToolCallFact;
    }
  | { ok: false; failureCode: FailureCode } {
  // The managed forwarding edge joins its request ID to the SDK call before
  // publishing the ask. Never guess the current/most-recent child tool call.
  const childToolId = runtime?.requestTools?.[details.requestId];
  const witnessed =
    childToolId && (!details.toolCallId || details.toolCallId === childToolId)
      ? runtime?.toolCalls?.[childToolId]
      : undefined;
  const currentToolCall: ToolCallFact | undefined = forwarding
    ? witnessed && asRecord(witnessed.arguments)
      ? { id: childToolId!, name: witnessed.name, arguments: witnessed.arguments }
      : undefined
    : details.toolCallId
      ? lastToolCall(branch, details.toolCallId)
      : undefined;

  // Forwarded gate values may describe only one shell segment. The trusted host
  // must witness the complete child action before a model may review any gate.
  if ((details.source === "tool_call" || forwarding) && !currentToolCall) {
    return { ok: false, failureCode: forwarding ? "delegation_unbound" : "context_incomplete" };
  }
  if (
    currentToolCall &&
    request.toolName &&
    currentToolCall.name !== request.toolName &&
    currentToolCall.name !== request.invokedToolName
  ) {
    return { ok: false, failureCode: "context_incomplete" };
  }

  const action: Record<string, unknown> = {
    kind: details.payload.kind,
    gateRequest: {
      surface: request.surface,
      toolName: request.toolName,
      invokedToolName: request.invokedToolName,
      value: request.value,
      matchedPattern: request.matchedPattern,
      commandContext: request.commandContext,
      executedUnit: request.executedUnit,
    },
    accessIntent: details.accessIntent
      ? {
          surface: details.accessIntent.surface,
          matchValues: [...details.accessIntent.matchValues],
          boundaryValue: details.accessIntent.boundaryValue,
        }
      : null,
    currentToolCall: currentToolCall
      ? { name: currentToolCall.name, arguments: currentToolCall.arguments }
      : null,
    delegation: forwarding ? { requestScope: "subagent", agentName: forwarding.agentName } : null,
    gateEvidence: details.payload.evidence.map((item) => ({
      label: item.label,
      text: item.text,
      detail: item.detail,
    })),
  };

  let serialized: string;
  try {
    serialized = canonicalJson(action);
  } catch {
    return { ok: false, failureCode: "context_incomplete" };
  }
  if (estimateTokens(serialized) > MAX_ACTION_TOKENS) {
    return { ok: false, failureCode: "context_oversize" };
  }
  return { ok: true, action, actionDigest: textDigest(serialized), currentToolCall };
}

/** Read loaded project instructions, not guessed cwd files. Known loss fails closed. */
export function buildProjectRestrictions(
  ctx: ExtensionContext,
  loadedSystemPrompt?: string,
): { ok: true; restrictions: ProjectRestrictions } | { ok: false; failureCode: FailureCode } {
  let systemPrompt = loadedSystemPrompt;
  if (systemPrompt === undefined) {
    try {
      systemPrompt = ctx.getSystemPrompt();
    } catch {
      return { ok: false, failureCode: "context_incomplete" };
    }
  }
  if (typeof systemPrompt !== "string") return { ok: false, failureCode: "context_incomplete" };
  const projectStarts = systemPrompt.match(/<project_context>/g)?.length ?? 0;
  const projectEnds = systemPrompt.match(/<\/project_context>/g)?.length ?? 0;
  const instructionStarts = systemPrompt.match(/<project_instructions\b/g)?.length ?? 0;
  const instructionEnds = systemPrompt.match(/<\/project_instructions>/g)?.length ?? 0;
  const projectSections = [
    ...systemPrompt.matchAll(/<project_context>\s*([\s\S]*?)\s*<\/project_context>/g),
  ];
  // The SDK renders at most one project_context section. Multiple sections can
  // be a balanced outer-tag escape with instruction text hidden between them.
  if (
    projectStarts > 1 ||
    projectStarts !== projectEnds ||
    instructionStarts !== instructionEnds ||
    projectSections.length !== projectStarts
  ) {
    return { ok: false, failureCode: "context_incomplete" };
  }
  const entries: ProjectRestrictions["entries"] = [];
  const sources = new Set<string>();
  let parsedInstructions = 0;
  for (const projectSection of projectSections) {
    const body = projectSection[1] ?? "";
    // Accept the fixed SDK display heading if present; it is not provenance.
    // With or without it, all remaining non-whitespace must belong to a block.
    let coveredTo = /^Project-specific instructions and guidelines:\s*/.exec(body)?.[0].length ?? 0;
    for (const match of body.matchAll(
      /<project_instructions path="([^"]+)">\s*([\s\S]*?)\s*<\/project_instructions>/g,
    )) {
      if (
        body.slice(coveredTo, match.index).trim() ||
        /<\/?project_(?:context|instructions)\b/.test(match[2] ?? "")
      ) {
        return { ok: false, failureCode: "context_incomplete" };
      }
      coveredTo = match.index + match[0].length;
      parsedInstructions += 1;
      const source = match[1];
      sources.add(source);
      let section: string | null = null;
      for (const rawLine of (match[2] ?? "").split(/\r?\n/)) {
        const text = rawLine.trim();
        if (/^#{1,4}\s+/.test(text)) {
          section = text.replace(/^#{1,4}\s+/, "");
          if (RESTRICTIVE_CUE.test(text)) entries.push({ source, section: null, text });
          continue;
        }
        if (text && RESTRICTIVE_CUE.test(text)) entries.push({ source, section, text });
      }
    }
    if (body.slice(coveredTo).trim()) return { ok: false, failureCode: "context_incomplete" };
  }
  // Reject malformed/out-of-envelope instruction blocks rather than losing them.
  if (parsedInstructions !== instructionStarts)
    return { ok: false, failureCode: "context_incomplete" };
  const restrictions: ProjectRestrictions = {
    entries,
    sourceFileCount: sources.size,
    budgetOmittedRestrictionLines: 0,
    selectionMethod: "restrictive_cue_filter",
    authorizationEffect: "restriction_only",
  };
  if (estimateTokens(canonicalJson(entries)) > MAX_PROJECT_RESTRICTION_TOKENS) {
    return { ok: false, failureCode: "context_oversize" };
  }
  return { ok: true, restrictions };
}

/**
 * The repository-local script a bash command is about to run.
 *
 * Without this the review is asked to judge `bash scripts/build.sh` knowing only
 * its name. Measured on jev-1.13.0, attaching the body does not make a benign
 * build look safe -- a cmake build still reads 0.71 reversible, because cmake and
 * the compiler remain opaque whatever the wrapper says -- but it does turn a
 * hostile one from a deferral into a refusal: a build script with one extra line
 * posting ~/.ssh/id_ed25519 to a remote moved credential_exposure 0.10 -> 0.97
 * and remote_mutation 0.09 -> 0.94. The gain is entirely on the safety side, and
 * that asymmetry is the point: an unreadable script can never be cleared by
 * inspection, only condemned by it.
 *
 * Only inside the working tree, only a regular file, only a bounded prefix. The
 * body is untrusted evidence and the packet labels it as such; if it carries a
 * credential literal the sensitive-context gate drops the whole review rather
 * than shipping it off the machine.
 */
const MAX_SCRIPT_BYTES = 32_768;
const MAX_SCRIPT_CHARS = 3_000;
const SCRIPT_INVOCATION =
  /(?:^|[;&|(]\s*)\s*(?:(?:ba|z|k|da|fi)?sh\s+(?:-\S+\s+)*)?((?:\.{1,2}\/|[\w.-]+\/)[^\s;&|<>()]*)/;

export function invokedScriptFact(
  cwd: string,
  command: string | undefined,
): {
  path: string;
  source: "repository_working_tree";
  trust: "untrusted_evidence";
  body: string;
  truncated: boolean;
} | null {
  if (typeof command !== "string" || command === "") return null;
  const match = SCRIPT_INVOCATION.exec(command);
  const candidate = match?.[1];
  if (!candidate) return null;
  try {
    const root = realpathSync(cwd);
    // realpath first: a symlink out of the tree must not become a read of it.
    const resolved = realpathSync(resolve(root, candidate));
    if (resolved !== root && !resolved.startsWith(`${root}/`)) return null;
    const info = statSync(resolved);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SCRIPT_BYTES) return null;
    // A compiled binary is not a script, and its bytes would be noise in the
    // packet. Check the raw buffer for NUL and the decode for replacement
    // characters: reading as utf8 first hides binary behind U+FFFD, which an
    // earlier version of this check missed.
    const raw = readFileSync(resolved);
    if (raw.includes(0)) return null;
    const body = raw.toString("utf8");
    if (body.includes("�")) return null;
    return {
      path: resolved.slice(root.length + 1) || candidate,
      source: "repository_working_tree",
      trust: "untrusted_evidence",
      body: body.length > MAX_SCRIPT_CHARS ? body.slice(0, MAX_SCRIPT_CHARS) : body,
      truncated: body.length > MAX_SCRIPT_CHARS,
    };
  } catch {
    return null;
  }
}

export function recentToolCallFacts(
  branch: readonly unknown[],
  currentToolCallId: string | undefined,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const recent: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const call of reverseToolCalls(branch)) {
    // Exclude ALL occurrences, not just the last matching ID. Null IDs still
    // participate when the current ID is undefined, just as filter() did.
    if (call.id === currentToolCallId) continue;
    recent.push({ name: call.name, arguments: call.arguments });
    if (recent.length === MAX_RECENT_TOOL_CALLS) break;
  }
  return recent.reverse();
}

export function latestCompactionSummary(branch: readonly unknown[]): string | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(branch[index]);
    if (entry?.type !== "compaction") continue;
    const summary =
      typeof entry.summary === "string" ? entry.summary : textFromContent(entry.content);
    return summary ? summary.slice(0, 4000) : null;
  }
  return null;
}
