import { createHash } from "node:crypto";
import {
  MAX_NET_PATCH_ROWS,
  type NetEvidence,
  type NetHunkInput,
  netEvidence,
} from "./owner-change-net.ts";

export type OwnerChangePatch = Readonly<
  | {
      kind: "edit";
      added: number;
      removed: number;
      lines: readonly Readonly<{
        kind: "add" | "remove";
        line: number;
        text: string;
        noLf?: true;
      }>[];
      truncated: boolean;
      redacted: boolean;
    }
  | {
      kind: "unavailable";
      reason: "write-no-before" | "sensitive" | "missing-or-unverified" | "oversized";
    }
>;
type Unavailable = Extract<OwnerChangePatch, { kind: "unavailable" }>;
type PatchEvidence = Unavailable | { kind: "seal"; rawPath: string; digest: string };
type PatchLine = Extract<OwnerChangePatch, { kind: "edit" }>["lines"][number];
type PatchResult = { patch: OwnerChangePatch; net?: NetEvidence };

const MAX_PATCH = 64 * 1024;
const MAX_ROWS = 24;
const MAX_TEXT = 256;
const MAX_SCAN_LINE = 1024;
const unavailable = (reason: Unavailable["reason"]): Unavailable =>
  Object.freeze({ kind: "unavailable", reason });
const UNVERIFIED = unavailable("missing-or-unverified");
const SENSITIVE = unavailable("sensitive");
const OVERSIZED = unavailable("oversized");
export const WRITE_NO_BEFORE = unavailable("write-no-before");

/** Never invoke an accessor on a result, argument, or details object. */
export const ownData = (value: unknown, name: string): unknown =>
  value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, name)?.value
    : undefined;

// Heuristic only: lexical paths do not identify symlink targets, and ordinary
// names and unmarked lines can contain secrets. Withhold matching paths'
// previews even with a source extension: e.g. tokens.ts could hold bare values.
// Never inspect other IO for this.
const PRIVATE_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.envrc|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:[_.][^/]*)?|(?:\.|[^/]+[_.-])?(?:secrets?|credentials?|passwords?|tokens?)(?:[_.-][^/]*)?|[^/]+\.(?:pem|key|p12|pfx|kdbx))(?:\/|$)/i;
const PRIVATE_ASSIGNMENT =
  /(?:^|[\W_])(?:api[-_ ]?key|access[-_ ]?key|password|passwd|secret|token|credential|authorization|cookie)["']?\s*[:=]/i;
const PRIVATE_VALUE =
  /(?:\bbearer\s+[\w./+~-]|(?:^|[^\w-])(?:sk-(?:proj-)?[\w-]{12}|gh[pousr]_[\w]{12}|github_pat_[\w]{12}|AKIA[A-Z0-9]{16}|eyJ[\w-]{8,1024}\.[\w-]{8,1024}\.[\w-]{8})|:\/\/[^/\s:@]{1,256}:[^/\s@]{1,512}@)/i;
const PRIVATE_BLOCK = /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|PGP MESSAGE)-----/i;
// Quarantine binary-looking content or terminal string protocols wholesale:
// not even a later changed line of an unterminated sequence should be copied.
const UNSAFE_PATCH = /[^\P{Cc}\t\n]|[\p{Cs}\ufffd]/u;

function patchText(details: unknown): string | Unavailable {
  const raw = ownData(details, "patch");
  if (typeof raw !== "string" || typeof ownData(details, "diff") !== "string") return UNVERIFIED;
  return raw.length > MAX_PATCH ? OVERSIZED : raw;
}

const fingerprint = (patch: string): string =>
  createHash("sha256").update(patch, "utf16le").digest("hex");

/** Remember only a seal until the matching successful SDK completion arrives.
 * Neither the raw patch nor the input/output content escapes the hooks. */
export function observeEditPatch(details: unknown, rawPath: string, path: string): PatchEvidence {
  if (PRIVATE_PATH.test(path) || PRIVATE_PATH.test(rawPath)) return SENSITIVE;
  const raw = patchText(details);
  return typeof raw === "string"
    ? {
        kind: "seal",
        rawPath: Buffer.from(rawPath, "utf16le").toString("utf16le"),
        digest: fingerprint(raw),
      }
    : raw;
}

function lineText(raw: string): { text: string; truncated: boolean } {
  // Retain the spelling/indentation except where an explicit escape is needed.
  const escaped = raw.replace(/[\\\t\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => {
    if (char === "\\") return "\\\\";
    if (char === "\t") return "\\t";
    const code = char.codePointAt(0)!;
    return code <= 0xffff
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : `\\u{${code.toString(16)}}`;
  });
  const truncated = escaped.length > MAX_TEXT;
  const clipped = truncated
    ? `${escaped.slice(0, MAX_TEXT - 1).replace(/\p{Cs}$/u, "")}…`
    : escaped;
  // Don't keep a substring backed by the SDK's full patch or an unbounded line.
  return { text: Buffer.from(clipped, "utf16le").toString("utf16le"), truncated };
}

/** Accept only the pinned SDK's single-target, LF-normalized unified patch
 * shape. Count every validated +/- row, even if preview rows are omitted. */
function previewPatch(raw: string, rawPath: string): PatchResult {
  const headers = `--- ${rawPath}\n+++ ${rawPath}\n`;
  if (!raw.startsWith(headers) || !raw.endsWith("\n")) return { patch: UNVERIFIED };
  if (UNSAFE_PATCH.test(raw) || PRIVATE_BLOCK.test(raw)) return { patch: SENSITIVE };
  const rows = raw.slice(headers.length, -1).split("\n");
  // Hunk headers, empty rows and EOF markers also count towards this budget.
  // The preview still scans and validates every row when composition is unavailable.
  const netHunks: NetHunkInput[] | undefined =
    rows.length <= MAX_NET_PATCH_ROWS && !rawPath.includes("\n") ? [] : undefined;
  const lines: PatchLine[] = [];
  let added = 0,
    removed = 0,
    truncated = false,
    redacted = false,
    priorOldEnd = 1,
    priorNewEnd = 1,
    oldEof: number | undefined,
    newEof: number | undefined,
    i = 0;
  while (i < rows.length) {
    const header = rows[i++]!;
    if (header.length > 80) return { patch: UNVERIFIED };
    const hunk = /^@@ -(0|[1-9]\d*),(0|[1-9]\d*) \+(0|[1-9]\d*),(0|[1-9]\d*) @@$/.exec(header);
    if (!hunk) return { patch: UNVERIFIED };
    const oldStart = Number(hunk[1]),
      oldCount = Number(hunk[2]),
      newStart = Number(hunk[3]),
      newCount = Number(hunk[4]);
    // An empty range names the previous line in unified format. Convert to
    // the actual next-line position before comparing unreported equal context.
    let oldLine = oldStart + (oldCount === 0 ? 1 : 0);
    let newLine = newStart + (newCount === 0 ? 1 : 0);
    const oldEnd = oldLine + oldCount;
    const newEnd = newLine + newCount;
    if (
      !Number.isSafeInteger(oldEnd) ||
      !Number.isSafeInteger(newEnd) ||
      oldLine < priorOldEnd ||
      newLine < priorNewEnd ||
      oldLine - priorOldEnd !== newLine - priorNewEnd ||
      (oldEof !== undefined && oldEnd > oldEof) ||
      (newEof !== undefined && newEnd > newEof) ||
      oldCount + newCount > 2 * rows.length
    )
      return { patch: UNVERIFIED };
    const netHunk: NetHunkInput | undefined =
      netHunks && !truncated && !redacted
        ? { start: newLine - 1, before: [], after: [] }
        : undefined;
    let changed = false;
    while (oldLine < oldEnd || newLine < newEnd) {
      const row = rows[i++];
      const marker = row?.[0];
      if (!row || (marker !== " " && marker !== "+" && marker !== "-"))
        return { patch: UNVERIFIED };
      if (marker !== "+" && (oldLine === oldEnd || oldEof !== undefined))
        return { patch: UNVERIFIED };
      if (marker !== "-" && (newLine === newEnd || newEof !== undefined))
        return { patch: UNVERIFIED };
      // Don't assume a safe prefix of an unusually long line (context too).
      if (row.length > MAX_SCAN_LINE + 1) return { patch: OVERSIZED };
      const text = row.slice(1);
      // Both `:` (e.g. YAML plain scalars) and `=` (e.g. INI values) can
      // continue onto unmarked rows, even across hidden hunk context. A
      // filename or an apparent single-line value does not prove a boundary.
      if (PRIVATE_ASSIGNMENT.test(text)) return { patch: SENSITIVE };
      const withheld = PRIVATE_VALUE.test(text);
      if (marker === " " && withheld) return { patch: SENSITIVE };
      const noLf = rows[i] === "\\ No newline at end of file";
      let displayText: string | undefined;
      if (marker !== " ") {
        changed = true;
        const isAdd = marker === "+";
        if (isAdd) added++;
        else removed++;
        redacted ||= withheld;
        if (lines.length === MAX_ROWS) truncated = true;
        else {
          const display = withheld
            ? { text: "[possible credential withheld]", truncated: false }
            : lineText(text);
          truncated ||= display.truncated;
          displayText = display.text;
          lines.push(
            Object.freeze({
              kind: isAdd ? "add" : "remove",
              line: isAdd ? newLine : oldLine,
              text: displayText,
              ...(noLf ? { noLf: true as const } : {}),
            }),
          );
        }
      }
      if (netHunk && !redacted && !truncated) {
        const source = { raw: text, text: displayText, noLf };
        if (marker !== "+") netHunk.before.push(source);
        if (marker !== "-") netHunk.after.push(marker === " " ? netHunk.before.length - 1 : source);
      }
      if (marker !== "+") oldLine++;
      if (marker !== "-") newLine++;
      if (noLf) {
        if (marker !== "+") oldEof = oldLine;
        if (marker !== "-") newEof = newLine;
        i++;
      }
    }
    if (!changed) return { patch: UNVERIFIED };
    if (netHunk) netHunks!.push(netHunk);
    priorOldEnd = oldEnd;
    priorNewEnd = newEnd;
  }
  if (!added && !removed) return { patch: UNVERIFIED };
  const patch: OwnerChangePatch = Object.freeze({
    kind: "edit",
    added,
    removed,
    lines: Object.freeze(lines),
    truncated,
    redacted,
  });
  // Redaction and clipping are display-only. Never seal partial row evidence.
  const net =
    netHunks && !truncated && !redacted
      ? netEvidence(netHunks, {
          oldMin: priorOldEnd - 1,
          newMin: priorNewEnd - 1,
          oldEof: oldEof === undefined ? undefined : oldEof - 1,
          newEof: newEof === undefined ? undefined : newEof - 1,
        })
      : undefined;
  return { patch, net };
}

export function finishEditPatch(evidence: PatchEvidence | undefined, result: unknown): PatchResult {
  if (!evidence) return { patch: UNVERIFIED };
  if (evidence.kind === "unavailable") return { patch: evidence };
  const raw = patchText(ownData(result, "details"));
  if (typeof raw !== "string" || fingerprint(raw) !== evidence.digest) return { patch: UNVERIFIED };
  return previewPatch(raw, evidence.rawPath);
}
