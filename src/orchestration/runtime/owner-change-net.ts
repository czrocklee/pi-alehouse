import { createHmac, randomBytes } from "node:crypto";
import type { OwnerChangePatch } from "./owner-change-patch.ts";

// Purely in-memory line evidence for normalized SDK edits. There is no file
// identity, session-start snapshot, or coverage of unobserved writers here.
// Never store an SDK patch, unchanged text, clipped text or a withheld value.
type Line = Readonly<{ key: string; text?: string; noLf: boolean }>;
type Hunk<T = Line> = {
  start: number; // zero-based position in this patch's postimage
  before: T[];
  after: (T | number)[]; // a number references a surviving before line
};
type Bounds = { oldMin: number; newMin: number; oldEof?: number; newEof?: number };
export type NetEvidence = Readonly<Bounds & { hunks: readonly Hunk[]; rows: number }>;

type SourceLine = { raw: string; text?: string; noLf: boolean };
export type NetHunkInput = Hunk<SourceLine>;
export const MAX_NET_PATCH_ROWS = 256;
const MAX_CHAIN_ROWS = 512;
const MAX_CELLS = 128 * 1024;
const MAX_PREVIEW = 24;
const unknown = Object.freeze({ kind: "unavailable", reason: "missing-or-unverified" } as const);
const over = Object.freeze({ kind: "unavailable", reason: "oversized" } as const);
let equalityKey: Buffer | undefined;

/** Seal the bounded rows collected by the patch parser only after the whole
 * preview is verified, unclipped, and unredacted. Neither raw rows nor the
 * temporary equality cache are retained. */
export function netEvidence(
  input: readonly NetHunkInput[],
  bounds: Bounds,
): NetEvidence | undefined {
  // Leave room for coordinate arithmetic across the entire bounded chain.
  if (Math.max(bounds.oldMin, bounds.newMin) > Number.MAX_SAFE_INTEGER - MAX_CHAIN_ROWS)
    return undefined;
  const hash = (raw: string, noLf: boolean) =>
    createHmac("sha256", (equalityKey ??= randomBytes(32)))
      .update(noLf ? "0" : "1")
      .update(raw, "utf16le")
      .digest("base64");
  const lfKeys = new Map<string, string>();
  const seal = ({ raw, text, noLf }: SourceLine): Line => {
    // Unterminated rows are rare and must not share the LF cache domain.
    let key = noLf ? hash(raw, true) : lfKeys.get(raw);
    if (key === undefined) lfKeys.set(raw, (key = hash(raw, false)));
    return text === undefined ? { key, noLf } : { key, noLf, text };
  };
  let rows = 0;
  const hunks = input.map(({ start, before, after }) => ({
    start,
    before: before.map((line) => {
      rows++;
      return seal(line);
    }),
    after: after.map((line) => {
      if (typeof line === "number") return line;
      rows++;
      return seal(line);
    }),
  }));
  return { ...bounds, hunks, rows };
}

// Untouched baseline lines retain their identity through all splices. Omitted
// file regions, even billion-line gaps, occupy a single range, not an array.
type Range = { from: number; length: number };
type Piece = Range | Line;
const width = (p: Piece) => ("from" in p ? p.length : 1);
function cut(tape: Piece[], position: number): number {
  for (let i = 0; i < tape.length; i++) {
    if (position === 0) return i;
    const p = tape[i]!;
    if ("from" in p && position < p.length) {
      tape.splice(
        i,
        1,
        { from: p.from, length: position },
        { from: p.from + position, length: p.length - position },
      );
      return i + 1;
    }
    position -= width(p);
  }
  return tape.length;
}

function apply(h: Hunk, tape: Piece[], known: Map<number, Line>): boolean {
  const start = cut(tape, h.start);
  const end = cut(tape, h.start + h.before.length);
  const consumed: Piece[] = [];
  for (let i = start; i < end; i++) {
    const p = tape[i]!;
    if ("from" in p) {
      for (let n = 0; n < p.length; n++) {
        const expected = h.before[consumed.length]!;
        const id = p.from + n;
        const prior = known.get(id);
        if (prior && expected.key !== prior.key) return false;
        if (!prior || expected.text !== undefined) known.set(id, expected);
        consumed.push(p.length === 1 ? p : { from: id, length: 1 });
      }
    } else {
      if (p.key !== h.before[consumed.length]!.key) return false;
      consumed.push(p);
    }
  }
  if (consumed.length !== h.before.length) return false;
  tape.splice(
    start,
    end - start,
    ...h.after.map((p) => (typeof p === "number" ? consumed[p]! : p)),
  );
  return true;
}

// Align observed baseline and final rows, not the stream of operations. This
// cancels exact reversals, including duplicate text and partial reversals in
// a replaced block. Never render an unchanged context line as a change.
type Preview = Extract<OwnerChangePatch, { kind: "edit" }>;
type DisplayLine = Preview["lines"][number];
function renderNet(tape: Piece[], known: Map<number, Line>, size: number): OwnerChangePatch {
  const cuts = new Set([0, size]);
  for (const n of known.keys()) {
    cuts.add(n);
    cuts.add(n + 1);
  }
  for (const p of tape)
    if ("from" in p) {
      cuts.add(p.from);
      cuts.add(p.from + p.length);
    }
  const boundaries = [...cuts].sort((a, b) => a - b);
  const old: Piece[] = [];
  const index = new Map<number, number>();
  for (const [i, pos] of boundaries.entries()) {
    index.set(pos, i);
    if (pos === size) break;
    old.push(known.get(pos) ?? { from: pos, length: boundaries[i + 1]! - pos });
  }
  const current: Piece[] = [];
  for (const p of tape) {
    if ("key" in p) current.push(p);
    else {
      const end = index.get(p.from + p.length)!;
      for (let i = index.get(p.from)!; i < end; i++) current.push(old[i]!);
    }
  }
  const cols = current.length + 1;
  const cells = (old.length + 1) * cols;
  if (cells > MAX_CELLS) return over;
  // Assign comparison IDs once, not at each DP cell. Only known lines are
  // skippable; an opaque range can only match its own baseline range object.
  const ids = new Map<string | Range, number>();
  const tokens = (pieces: Piece[]) => {
    const result = new Int32Array(pieces.length + 1); // 0 sentinel at the end
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const key = "key" in p ? p.key : p;
      let id = ids.get(key);
      if (id === undefined) {
        id = (ids.size + 1) * (typeof key === "string" ? 1 : -1);
        ids.set(key, id);
      }
      result[i] = id;
    }
    return result;
  };
  const oldIds = tokens(old),
    newIds = tokens(current);
  // Common equal prefix/suffix cannot affect minimum insert/delete counts.
  // Inside that boundary an opaque run is NOT a unique text anchor: it might
  // be full of the same repeated line as a distant insertion and deletion.
  let left = 0,
    right = old.length,
    newRight = current.length;
  while (left < right && left < newRight && oldIds[left] === newIds[left]) left++;
  while (left < right && left < newRight && oldIds[right - 1] === newIds[newRight - 1]) {
    right--;
    newRight--;
  }
  let residual: Map<string, DisplayLine["kind"]> | undefined;
  for (let i = left; i < right; i++) {
    if (oldIds[i]! < 0) {
      residual = new Map();
      break;
    }
  }
  const scores = new Int32Array(cells);
  // Find a shortest script, not just a renderable one. Only traceback needs
  // to refuse a context-only line (its actual display text is not retained).
  const invalid = -1000000;
  for (let i = old.length; i >= 0; i--) {
    const a = oldIds[i]!;
    for (let j = current.length; j >= 0; j--) {
      const b = newIds[j]!,
        cell = i * cols + j;
      if (!a && !b) continue;
      scores[cell] = Math.max(
        a && a === b ? 1 + scores[cell + cols + 1]! : invalid,
        a > 0 ? scores[cell + cols]! : invalid,
        b > 0 ? scores[cell + 1]! : invalid,
      );
    }
  }
  if (scores[0]! < 0) return unknown;
  const lines: DisplayLine[] = [];
  let added = 0,
    removed = 0,
    i = 0,
    j = 0,
    oldLine = 1,
    newLine = 1;
  while (i < old.length || j < current.length) {
    const a = old[i],
      b = current[j],
      cell = i * cols + j;
    if (a && oldIds[i] === newIds[j] && scores[cell] === 1 + scores[cell + cols + 1]!) {
      const count = width(a);
      oldLine += count;
      newLine += count;
      i++;
      j++;
      continue;
    }
    let kind: DisplayLine["kind"], line: number, row: Line;
    if (a && "key" in a && a.text !== undefined && scores[cell] === scores[cell + cols]) {
      kind = "remove";
      row = a;
      line = oldLine++;
      removed++;
      i++;
    } else if (b && "key" in b && b.text !== undefined && scores[cell] === scores[cell + 1]) {
      kind = "add";
      row = b;
      line = newLine++;
      added++;
      j++;
    } else return unknown;
    if (residual) {
      // Disjoint residual multisets attain a content-independent lower
      // bound, even if gaps contain duplicates. Opposite rows with the
      // same key cannot certify that: return unknown, not a nonminimal
      // diff (or a guessed cancellation). Check rows beyond preview too.
      const prior = residual.get(row.key);
      if (prior && prior !== kind) return unknown;
      residual.set(row.key, kind);
    }
    if (lines.length < MAX_PREVIEW)
      lines.push(
        Object.freeze({ kind, line, text: row.text!, ...(row.noLf && { noLf: true as const }) }),
      );
  }
  return Object.freeze({
    kind: "edit",
    added,
    removed,
    lines: Object.freeze(lines),
    truncated: added + removed > lines.length,
    redacted: false,
  });
}

/** Caller supplies one lexical path in known execution order. An undefined
 * step is a barrier (unknown before-state, missing observation or ambiguous
 * ordering); do not restart after it and relabel a suffix as the whole net. */
export function composeNet(chain: readonly (NetEvidence | undefined)[]): OwnerChangePatch {
  if (!chain.length) return unknown;
  if (chain.length > MAX_CHAIN_ROWS) return over;
  let rows = 0,
    delta = 0,
    size = 0,
    eof: number | undefined;
  for (const step of chain) {
    if (!step) return unknown;
    rows += step.rows;
    if (rows > MAX_CHAIN_ROWS) return over;
    size = Math.max(size, step.oldMin - delta);
    const oldDelta = delta;
    delta += step.newMin - step.oldMin;
    for (const bound of [
      step.oldEof === undefined ? undefined : step.oldEof - oldDelta,
      step.newEof === undefined ? undefined : step.newEof - delta,
    ]) {
      if (bound === undefined) continue;
      if (eof !== undefined && eof !== bound) return unknown;
      eof = bound;
    }
  }
  if (eof !== undefined && size !== eof) return unknown;
  const tape: Piece[] = size ? [{ from: 0, length: size }] : [];
  const known = new Map<number, Line>();
  let lastOriginalWasInterior = false;
  for (const step of chain) {
    for (const h of step!.hunks) if (!apply(h, tape, known)) return unknown;
    // A patch cannot append after an unterminated line without replacing
    // that line. Its missing LF might be learned only from a later patch.
    for (let i = 0; i < tape.length - 1; i++) {
      const p = tape[i]!;
      if ("from" in p) lastOriginalWasInterior ||= p.from + p.length === size;
      else if (p.noLf) return unknown;
    }
  }
  for (const [pos, line] of known) {
    if (line.noLf && (pos !== size - 1 || lastOriginalWasInterior)) return unknown;
  }
  return renderNet(tape, known, size);
}
